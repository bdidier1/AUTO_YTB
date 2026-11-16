"""Chaine de traitement d'une video.

   telechargement -> preparation (apercu leger, miniature, lecture du texte) -> conversion 4K60
   en parallele, l'utilisateur :  apercu + decoupage  ->  details de mise en ligne  ->  envoi

status : queued, downloading, preparing, converting, converted, uploading, done, error
stage  : preview (etape apercu), details (formulaire), submitted (envoi demande)
"""
import json
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yt_dlp
from google.auth.exceptions import RefreshError

from . import convert, db, ocr, youtube
from .config import COOKIES_FILE, MAX_DOWNLOAD_BYTES, VIDEOS

_download_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="dl")
_convert_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="conv")   # 4K = lourd : une a la fois
_upload_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="up")
_lock = threading.RLock()

HASHTAG_RE = re.compile(r"#(\w+)", re.UNICODE)
BUSY = ("queued", "downloading", "preparing", "converting", "uploading")


# --- Utilitaires -------------------------------------------------------------

def _clean_text(s: str) -> str:
    return (s or "").replace("<", "").replace(">", "").strip()


def _strip_hashtags(s: str) -> str:
    s = HASHTAG_RE.sub("", s or "")
    return re.sub(r"[ \t]{2,}", " ", s).strip()


def _extract_hashtags(*texts, extra=()) -> list[str]:
    seen, out = set(), []
    for t in texts:
        for h in HASHTAG_RE.findall(t or ""):
            if h.lower() not in seen:
                seen.add(h.lower())
                out.append(h)
    for h in extra:
        h = str(h).lstrip("#").strip()
        if h and re.fullmatch(r"\w+", h) and h.lower() not in seen:
            seen.add(h.lower())
            out.append(h)
    return out[:30]


ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _quality_label(info: dict) -> str:
    """Description de la qualite reellement telechargee (format video choisi)."""
    parts = []
    for f in info.get("requested_formats") or [info]:
        if f.get("vcodec") and f.get("vcodec") != "none":
            codec = str(f.get("vcodec")).split(".")[0].replace("avc1", "H.264").replace("h264", "H.264")
            codec = codec.replace("hev1", "H.265").replace("hvc1", "H.265").replace("h265", "H.265").replace("vp09", "VP9").replace("av01", "AV1")
            res = f"{f.get('width')}x{f.get('height')}" if f.get("width") else (f.get("resolution") or "")
            br = f.get("vbr") or f.get("tbr")
            parts.append(" · ".join(x for x in (res, codec, f"{round(br)} kb/s" if br else "") if x))
    return parts[0] if parts else ""


def _fail(job_id, msg):
    db.update_job(job_id, status="error", message=ANSI_RE.sub("", str(msg))[:500])


def _path(p) -> Path | None:
    return Path(p) if p and Path(p).exists() else None


def cleanup_orphans():
    """Au demarrage : supprime les fichiers video qui n'appartiennent plus a aucun travail
    (restes d'une coupure, fichiers temporaires), pour ne pas encombrer le disque."""
    keep, busy = set(), set()
    for j in db.query("SELECT id, status, source_path, output_path, preview_path, thumb_path FROM jobs"):
        if j["status"] not in ("done", "error"):
            busy.add(j["id"])          # traitement en cours : on ne touche a rien
        for k in ("source_path", "output_path", "preview_path", "thumb_path"):
            if j[k]:
                keep.add(Path(j[k]).name)
    for p in VIDEOS.iterdir():
        in_use = any(p.name.startswith(i) or p.name.startswith(".tmp_" + i) for i in busy)
        if p.is_file() and p.name not in keep and not in_use:
            try:
                p.unlink()
            except OSError:
                pass


# --- Telechargement + preparation --------------------------------------------

def add(url: str) -> str:
    job_id = uuid.uuid4().hex[:12]
    db.create_job(job_id, url)
    _download_pool.submit(_download, job_id)
    return job_id


def _download(job_id):
    job = db.get_job(job_id)
    db.update_job(job_id, status="downloading", progress=0, message="Telechargement...", stage="preview")

    def hook(d):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total:
                db.update_job(job_id, progress=round(d.get("downloaded_bytes", 0) / total * 100, 1))

    opts = {
        "outtmpl": str(VIDEOS / f"{job_id}_src.%(ext)s"),
        # Meilleure qualite possible : jamais la version avec filigrane ("download" TikTok) ni le son
        # compresse "DRC" de YouTube,
        # puis resolution la plus haute, puis images/s, puis debit le plus eleve (= plus de details).
        "format": ("bv*[format_id!=download]+ba[format_id!*=drc]/bv*[format_id!=download]+ba"
                   "/b[format_id!=download]/bv*+ba/b"),
        "format_sort": ["res", "fps", "br", "size"],
        "merge_output_format": "mp4",
        "noplaylist": True,
        "playlist_items": "1",
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "max_filesize": MAX_DOWNLOAD_BYTES,
        "progress_hooks": [hook],
        "socket_timeout": 30,
        "retries": 5,
        "color": {"stdout": "no_color", "stderr": "no_color"},
        "ffmpeg_location": str(Path(convert.FFMPEG).parent) if convert.FFMPEG else None,
    }
    if COOKIES_FILE.exists():
        opts["cookiefile"] = str(COOKIES_FILE)
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(job["url"], download=True)
            if info.get("_type") == "playlist":
                entries = [e for e in info.get("entries") or [] if e]
                if not entries:
                    raise RuntimeError("Aucune video trouvee a ce lien")
                info = entries[0]
            reqs = info.get("requested_downloads") or []
            path = Path(reqs[0]["filepath"]) if reqs and reqs[0].get("filepath") else Path(ydl.prepare_filename(info))
        if not path.exists():
            raise RuntimeError("Fichier telecharge introuvable")
    except yt_dlp.utils.DownloadError as e:
        msg = ANSI_RE.sub("", str(e)).replace("ERROR: ", "")
        low = msg.lower()
        if "login" in low or "cookies" in low or "comfortable" in low:
            if COOKIES_FILE.exists():
                msg = ("Le site refuse meme avec tes cookies : ils ont peut-etre expire, ou ton compte n'a pas acces "
                       "a cette video (ex. compte de moins de 18 ans). Reimporte des cookies frais "
                       "(menu du profil > Gerer les comptes > Cookies). Detail : " + msg[:200])
            else:
                msg = ("Cette video est reservee aux comptes connectes (contenu sensible ou prive). "
                       "Importe tes cookies (menu du profil > Gerer les comptes > Cookies) puis clique sur Reessayer. "
                       "Detail : " + msg[:200])
        elif "unexpected response" in low or "impersonat" in low:
            msg = ("Le site a bloque le telechargement (protection anti-robot). Relance LANCER.bat pour "
                   "mettre a jour le telechargeur, puis clique sur Reessayer. Detail : " + msg[:200])
        return _fail(job_id, msg)
    except Exception as e:  # noqa: BLE001
        return _fail(job_id, f"Telechargement impossible : {e}")

    raw_title = info.get("title") or ""
    if re.fullmatch(r"(TikTok|Instagram|Facebook|Twitter|X) (video|post|reel) #?\w+", raw_title, re.I):
        raw_title = ""   # titre generique sans interet : on se rabat sur la description / l'OCR
    raw_desc = info.get("description") or ""
    title = _clean_text(_strip_hashtags(raw_title)) or _clean_text(_strip_hashtags(raw_desc).split("\n")[0])
    title = title or _clean_text(info.get("uploader") or "") or "Video"
    db.update_job(
        job_id, status="preparing", progress=0, message="Preparation de l'apercu...",
        source_path=str(path),
        src_title=title[:100],
        src_description=_clean_text(_strip_hashtags(raw_desc))[:4500],
        src_hashtags=json.dumps(_extract_hashtags(raw_title, raw_desc, extra=info.get("tags") or [])),
        src_platform=info.get("extractor_key") or info.get("extractor") or "",
        src_quality=_quality_label(info),
    )
    _prepare(job_id)


def _prepare(job_id):
    job = db.get_job(job_id)
    src = Path(job["source_path"])
    try:
        info = convert.probe(src)
        thumb = VIDEOS / f"{job_id}.jpg"
        convert.thumbnail(src, thumb)
        prev = VIDEOS / f"{job_id}_preview.mp4"
        convert.preview(src, prev)
        db.update_job(job_id, src_width=info["width"], src_height=info["height"], src_fps=info["fps"],
                      duration=info["duration"], thumb_path=str(thumb) if thumb.exists() else None,
                      preview_path=str(prev), progress=60, message="Lecture du texte de la video...")
        text = ocr.analyse(src, info["duration"])
        db.update_job(job_id, ocr_title=text["title"], watermark=int(text["watermark"]))
    except Exception as e:  # noqa: BLE001
        return _fail(job_id, f"Preparation : {e}")
    _start_convert(job_id)


# --- Conversion 4K ------------------------------------------------------------

def _start_convert(job_id):
    with _lock:
        job = db.get_job(job_id)
        gen = (job["conv_gen"] or 0) + 1
        db.update_job(job_id, conv_gen=gen, conv_edit=job["edit"], status="converting", progress=0,
                      out_info=None, message="Conversion 4K 60 i/s...")
    _convert_pool.submit(_convert, job_id, gen)


def _convert(job_id, gen):
    job = db.get_job(job_id)
    if not job or job["conv_gen"] != gen:
        return
    src = Path(job["source_path"])
    dest = VIDEOS / f"{job_id}_4k.mp4"
    edit = json.loads(job["conv_edit"]) if job["conv_edit"] else None
    try:
        info = convert.probe(src)
        done = convert.convert(src, dest, info, lambda p: db.update_job(job_id, progress=round(p, 1)),
                               edit=edit, key=f"{job_id}:{gen}")
        out = convert.probe(dest)
    except convert.Cancelled:
        return
    except Exception as e:  # noqa: BLE001
        with _lock:
            if (db.get_job(job_id) or {}).get("conv_gen") == gen:
                _fail(job_id, f"Conversion : {e}")
        return
    with _lock:
        job = db.get_job(job_id)
        if not job or job["conv_gen"] != gen:
            return
        db.update_job(job_id, output_path=str(dest), out_info=json.dumps(out), progress=100,
                      status="converted", message=done)
        if job["stage"] == "submitted" and job["conv_edit"] == job["edit"]:
            _start_upload(job_id)


# --- Envoi --------------------------------------------------------------------

def _start_upload(job_id):
    db.update_job(job_id, status="uploading", progress=0, message="Envoi vers YouTube...")
    _upload_pool.submit(_upload, job_id)


def _upload(job_id):
    job = db.get_job(job_id)
    meta = json.loads(job["publish"])
    publish_at = meta.get("publish_at")
    note = ""
    if publish_at:
        when = datetime.fromisoformat(publish_at.replace("Z", "+00:00"))
        if when < datetime.now(timezone.utc) + timedelta(minutes=2):
            publish_at, note = None, " (heure deja passee : publiee immediatement)"
    tags_room, tags = 480, []
    for h in meta["hashtags"]:
        if len(h) + 3 > tags_room:
            break
        tags.append(h)
        tags_room -= len(h) + 3
    description = meta["description"]   # les hashtags sont deja ecrits dedans
    try:
        vid = youtube.upload(
            meta["channel_id"], job["output_path"],
            {"title": meta["title"], "description": description[:5000], "tags": tags,
             "privacy": meta["privacy"], "publish_at": publish_at},
            lambda p: db.update_job(job_id, progress=round(p, 1)),
        )
    except youtube.YTError as e:
        return _fail(job_id, f"YouTube : {e}")
    except RefreshError:
        return _fail(job_id, "YouTube : " + youtube.REAUTH_MSG + " Puis clique sur Reessayer.")
    except Exception as e:  # noqa: BLE001
        return _fail(job_id, f"Envoi impossible : {e}")
    if publish_at:
        local = datetime.fromisoformat(publish_at.replace("Z", "+00:00")).astimezone()
        msg = f"Programmee pour le {local:%d/%m/%Y a %H:%M}"
    else:
        msg = {"public": "Publiee", "unlisted": "Publiee (non repertoriee)", "private": "Envoyee en prive"}[meta["privacy"]]
    for key in ("output_path", "source_path", "preview_path"):   # fichiers lourds : supprimes une fois en ligne
        if job[key]:
            Path(job[key]).unlink(missing_ok=True)
    db.update_job(job_id, status="done", progress=100, youtube_id=vid, output_path=None,
                  source_path=None, preview_path=None, message=msg + note)


# --- Actions utilisateur -----------------------------------------------------

def _get(job_id):
    job = db.get_job(job_id)
    if not job:
        raise ValueError("Video introuvable")
    return job


def validate(job_id: str, edit: dict | None):
    """Etape apercu validee : on applique le decoupage (reconversion si besoin)."""
    with _lock:
        job = _get(job_id)
        if job["status"] in ("queued", "downloading", "preparing"):
            raise ValueError("Attends la fin de la preparation de la video")
        if job["stage"] == "submitted" or job["status"] in ("uploading", "done"):
            raise ValueError("Cette video est deja en cours d'envoi")
        dur = job["duration"] or 0
        segs = convert.keep_segments(edit, dur)
        if not segs:
            raise ValueError("Ton decoupage ne garde aucun passage de la video")
        edit_json = None
        if not convert.is_full(segs, dur):
            edit_json = json.dumps({"start": segs[0][0], "end": segs[-1][1],
                                    "cuts": [[segs[i][1], segs[i + 1][0]] for i in range(len(segs) - 1)]})
        db.update_job(job_id, edit=edit_json, stage="details")
        up_to_date = edit_json == job["conv_edit"] and job["status"] in ("converting", "converted")
        if not up_to_date:
            if job["status"] == "converting":
                convert.cancel(f"{job_id}:{job['conv_gen']}")
            _start_convert(job_id)


def back_to_preview(job_id: str):
    with _lock:
        job = _get(job_id)
        if job["stage"] == "submitted":
            raise ValueError("Annule d'abord l'envoi programme")
        db.update_job(job_id, stage="preview")


def publish(job_id: str, meta: dict) -> str:
    with _lock:
        job = _get(job_id)
        if job["stage"] != "details":
            raise ValueError("Valide d'abord l'apercu")
        if job["status"] == "error":
            raise ValueError("Cette video est en erreur : clique sur Reessayer")
        db.update_job(job_id, publish=json.dumps(meta), stage="submitted")
        if job["status"] == "converted" and job["conv_edit"] == job["edit"]:
            _start_upload(job_id)
            return "Envoi en cours"
        return "Sera envoyee des que la conversion 4K est terminee"


def unsubmit(job_id: str):
    with _lock:
        job = _get(job_id)
        if job["stage"] != "submitted" or job["status"] in ("uploading", "done"):
            raise ValueError("L'envoi a deja commence")
        db.update_job(job_id, stage="details")


def retry(job_id: str):
    with _lock:
        job = _get(job_id)
        if job["status"] != "error":
            raise ValueError("Rien a reessayer")
        if not _path(job["source_path"]):
            db.update_job(job_id, status="queued", message="En attente", progress=0)
            _download_pool.submit(_download, job_id)
        elif not _path(job["preview_path"]):
            db.update_job(job_id, status="preparing", message="Preparation de l'apercu...", progress=0)
            _download_pool.submit(_prepare, job_id)
        elif (job["stage"] == "submitted" and _path(job["output_path"]) and job["out_info"]
              and job["conv_edit"] == job["edit"]):
            _start_upload(job_id)
        else:
            _start_convert(job_id)


def remove(job_id: str):
    with _lock:
        job = db.get_job(job_id)
        if not job:
            return
        if job["status"] in ("queued", "downloading", "preparing", "uploading"):
            raise ValueError("Impossible de supprimer pendant le telechargement ou l'envoi")
        if job["status"] == "converting":
            convert.cancel(f"{job_id}:{job['conv_gen']}")
        db.delete_job(job_id)
    for p in VIDEOS.glob(f"{job_id}*"):
        try:
            p.unlink(missing_ok=True)
        except PermissionError:
            pass   # fichier encore ouvert par ffmpeg qui s'arrete : il sera ecrase/ignore
