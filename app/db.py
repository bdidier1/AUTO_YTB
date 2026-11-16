"""Stockage SQLite (comptes + travaux). Les tokens OAuth sont chiffres (Fernet)."""
import json
import sqlite3
import threading
import time

from cryptography.fernet import Fernet

from .config import DB_FILE, KEY_FILE

_lock = threading.RLock()


def _load_key() -> bytes:
    if KEY_FILE.exists():
        return KEY_FILE.read_bytes()
    key = Fernet.generate_key()
    KEY_FILE.write_bytes(key)
    return key


_fernet = Fernet(_load_key())


def encrypt(obj) -> str:
    return _fernet.encrypt(json.dumps(obj).encode()).decode()


def decrypt(token: str):
    return json.loads(_fernet.decrypt(token.encode()))


def _conn():
    c = sqlite3.connect(DB_FILE, check_same_thread=False, timeout=30)
    c.row_factory = sqlite3.Row
    return c


_db = _conn()

with _lock:
    _db.executescript(
        """
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS accounts (
            channel_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            thumbnail TEXT,
            creds TEXT NOT NULL,
            added_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            status TEXT NOT NULL,
            progress REAL DEFAULT 0,
            message TEXT DEFAULT '',
            src_title TEXT DEFAULT '',
            src_description TEXT DEFAULT '',
            src_hashtags TEXT DEFAULT '[]',
            src_platform TEXT DEFAULT '',
            src_width INTEGER, src_height INTEGER, src_fps REAL, duration REAL,
            source_path TEXT, output_path TEXT, thumb_path TEXT,
            publish TEXT,
            youtube_id TEXT,
            created_at REAL NOT NULL
        );
        """
    )
    # Colonnes ajoutees apres la premiere version
    have = {r[1] for r in _db.execute("PRAGMA table_info(jobs)")}
    for col, typ in (("stage", "TEXT DEFAULT 'preview'"), ("edit", "TEXT"), ("conv_edit", "TEXT"),
                     ("conv_gen", "INTEGER DEFAULT 0"), ("out_info", "TEXT"), ("preview_path", "TEXT"),
                     ("ocr_title", "TEXT DEFAULT ''"), ("watermark", "INTEGER DEFAULT 0"),
                     ("suggestions", "TEXT"), ("src_quality", "TEXT DEFAULT ''")):
        if col not in have:
            _db.execute(f"ALTER TABLE jobs ADD COLUMN {col} {typ}")
    # Un redemarrage interrompt les traitements en cours : on les marque en erreur.
    _db.execute(
        "UPDATE jobs SET status='error', message='Interrompu (application redemarree)' "
        "WHERE status IN ('queued','downloading','preparing','converting','uploading')"
    )
    _db.commit()


def execute(sql, params=()):
    with _lock:
        cur = _db.execute(sql, params)
        _db.commit()
        return cur


def query(sql, params=()):
    with _lock:
        return [dict(r) for r in _db.execute(sql, params).fetchall()]


def query_one(sql, params=()):
    rows = query(sql, params)
    return rows[0] if rows else None


# --- Comptes -----------------------------------------------------------------

def save_account(channel_id, title, thumbnail, creds: dict):
    execute(
        "INSERT INTO accounts(channel_id,title,thumbnail,creds,added_at) VALUES(?,?,?,?,?) "
        "ON CONFLICT(channel_id) DO UPDATE SET title=excluded.title, thumbnail=excluded.thumbnail, creds=excluded.creds",
        (channel_id, title, thumbnail, encrypt(creds), time.time()),
    )


def list_accounts():
    return query("SELECT channel_id,title,thumbnail FROM accounts ORDER BY added_at")


def get_account_creds(channel_id):
    row = query_one("SELECT creds FROM accounts WHERE channel_id=?", (channel_id,))
    return decrypt(row["creds"]) if row else None


def update_account_creds(channel_id, creds: dict):
    execute("UPDATE accounts SET creds=? WHERE channel_id=?", (encrypt(creds), channel_id))


def update_account_meta(channel_id, title, thumbnail):
    execute("UPDATE accounts SET title=?, thumbnail=? WHERE channel_id=?", (title, thumbnail, channel_id))


def delete_account(channel_id):
    execute("DELETE FROM accounts WHERE channel_id=?", (channel_id,))


# --- Travaux -----------------------------------------------------------------

JOB_FIELDS = {
    "status", "progress", "message", "src_title", "src_description", "src_hashtags",
    "src_platform", "src_width", "src_height", "src_fps", "duration", "source_path",
    "output_path", "thumb_path", "publish", "youtube_id", "stage", "edit", "conv_edit", "conv_gen",
    "out_info", "preview_path", "ocr_title", "watermark", "suggestions", "src_quality",
}


def create_job(job_id, url):
    execute(
        "INSERT INTO jobs(id,url,status,message,created_at) VALUES(?,?,?,?,?)",
        (job_id, url, "queued", "En attente", time.time()),
    )


def update_job(job_id, **fields):
    bad = set(fields) - JOB_FIELDS
    if bad:
        raise ValueError(f"champs inconnus: {bad}")
    cols = ", ".join(f"{k}=?" for k in fields)
    execute(f"UPDATE jobs SET {cols} WHERE id=?", (*fields.values(), job_id))


def get_job(job_id):
    return query_one("SELECT * FROM jobs WHERE id=?", (job_id,))


def list_jobs():
    return query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100")


def delete_job(job_id):
    execute("DELETE FROM jobs WHERE id=?", (job_id,))
