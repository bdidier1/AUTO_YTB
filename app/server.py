"""Serveur web local (127.0.0.1 uniquement)."""
import ipaddress
import json
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

import requests
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from google.auth.exceptions import RefreshError
from googleapiclient.errors import HttpError
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool

from . import convert, db, pipeline, youtube
from .config import COOKIES_FILE, PORT, STATIC, VIDEOS

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
pipeline.cleanup_orphans()

ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
ALLOWED_ORIGINS = {f"http://{h}" for h in ALLOWED_HOSTS}
CHANNEL_RE = re.compile(r"^UC[\w-]{22}$")
JOB_RE = re.compile(r"^[0-9a-f]{12}$")

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; "
    "img-src 'self' data: https://*.ggpht.com https://*.googleusercontent.com https://*.ytimg.com; "
    "media-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
)


@app.middleware("http")
async def security(request: Request, call_next):
    # Anti DNS-rebinding : seul l'hote local est accepte.
    if request.headers.get("host", "") not in ALLOWED_HOSTS:
        return JSONResponse({"detail": "Hote refuse"}, status_code=403)
    # Anti-CSRF : toute ecriture exige un en-tete personnalise (impossible depuis un autre site
    # sans pre-verification CORS, que ce serveur n'autorise pas) et une origine locale.
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if request.headers.get("x-autoytb") != "1" or (origin and origin not in ALLOWED_ORIGINS):
            return JSONResponse({"detail": "Requete refusee"}, status_code=403)
    resp = await call_next(request)
    resp.headers["Content-Security-Policy"] = CSP
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.exception_handler(youtube.YTError)
async def yt_error(_, exc):
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(youtube.ReauthError)
async def reauth_error(_, exc):
    return JSONResponse({"detail": str(exc), "reconnect": True}, status_code=401)


@app.exception_handler(RefreshError)
async def refresh_error(_, exc):
    return JSONResponse({"detail": youtube.REAUTH_MSG, "reconnect": True}, status_code=401)


@app.exception_handler(HttpError)
async def http_error(_, exc):
    return JSONResponse({"detail": youtube.http_error_message(exc)}, status_code=502)


@app.exception_handler(ValueError)
async def value_error(_, exc):
    return JSONResponse({"detail": str(exc)}, status_code=400)


def _check_channel(cid: str):
    if not CHANNEL_RE.match(cid) or not db.get_account_creds(cid):
        raise HTTPException(404, "Compte inconnu")


def _check_job(jid: str) -> dict:
    job = db.get_job(jid) if JOB_RE.match(jid) else None
    if not job:
        raise HTTPException(404, "Video introuvable")
    return job


# --- Pages et OAuth ----------------------------------------------------------

@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/oauth/callback")
def oauth_callback(state: str = "", code: str = "", error: str = ""):
    if error or not code:
        return RedirectResponse("/#comptes?err=" + ("annule" if error == "access_denied" else "refuse"))
    try:
        youtube.finish_auth(state, code)
    except youtube.YTError:
        return RedirectResponse("/#comptes?err=echec")
    return RedirectResponse("/#comptes?ok=1")


# --- API : etat / comptes ----------------------------------------------------

@app.get("/api/status")
def status():
    return {
        "client_configured": youtube.client_configured(),
        "ffmpeg": bool(convert.FFMPEG and convert.FFPROBE),
        "encoder": convert.pick_encoder()[0] if convert.FFMPEG else None,
    }


@app.get("/api/accounts")
def accounts():
    return db.list_accounts()


@app.post("/api/accounts/connect")
def connect():
    return {"url": youtube.start_auth()}


@app.delete("/api/accounts/{cid}")
def disconnect(cid: str):
    _check_channel(cid)
    creds = db.get_account_creds(cid)
    try:  # revoque aussi l'autorisation cote Google
        requests.post("https://oauth2.googleapis.com/revoke",
                      data={"token": creds.get("refresh_token") or creds.get("token")}, timeout=10)
    except requests.RequestException:
        pass
    db.delete_account(cid)
    return {"ok": True}


# --- API : videos ------------------------------------------------------------

class NewJob(BaseModel):
    url: str = Field(max_length=2000)

    @field_validator("url")
    @classmethod
    def valid_url(cls, v):
        v = v.strip()
        u = urlparse(v)
        if u.scheme not in ("http", "https") or not u.hostname:
            raise ValueError("Lien invalide (il doit commencer par https://)")
        host = u.hostname.lower()
        if host == "localhost" or host.endswith(".local"):
            raise ValueError("Lien local refuse")
        try:
            ip = ipaddress.ip_address(host.strip("[]"))
        except ValueError:
            ip = None
        if ip and (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved):
            raise ValueError("Adresse privee refusee")
        return v


def _future_utc(v):
    if not v:
        return None
    try:
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError as e:
        raise ValueError("Date invalide") from e
    if dt.tzinfo is None:
        raise ValueError("Date sans fuseau horaire")
    dt = dt.astimezone(timezone.utc)
    if dt <= datetime.now(timezone.utc):
        raise ValueError("L'heure de publication doit etre dans le futur")
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _clean_tags(v):
    out = []
    for h in v or []:
        h = h.strip().lstrip("#")
        if not h:
            continue
        if not re.fullmatch(r"\w{1,60}", h):
            raise ValueError(f"Hashtag invalide : {h} (lettres, chiffres et _ uniquement)")
        out.append(h)
    return out


class PublishIn(BaseModel):
    channel_id: str
    title: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=5000)
    hashtags: list[str] = Field(default_factory=list, max_length=30)
    privacy: Literal["public", "unlisted", "private"] = "public"
    publish_at: str | None = None

    @field_validator("title", "description")
    @classmethod
    def no_angle(cls, v):
        v = v.strip()
        if "<" in v or ">" in v:
            raise ValueError("Les caracteres < et > sont interdits par YouTube")
        return v

    @field_validator("hashtags")
    @classmethod
    def tags_ok(cls, v):
        return _clean_tags(v)

    @field_validator("publish_at")
    @classmethod
    def future(cls, v):
        return _future_utc(v)


def _job_out(j: dict) -> dict:
    return {
        "id": j["id"], "url": j["url"], "status": j["status"], "progress": j["progress"],
        "message": j["message"], "title": j["src_title"], "description": j["src_description"],
        "hashtags": json.loads(j["src_hashtags"] or "[]"), "platform": j["src_platform"],
        "width": j["src_width"], "height": j["src_height"], "fps": j["src_fps"], "duration": j["duration"],
        "has_thumb": bool(j["thumb_path"]), "has_video": bool(j["output_path"]),
        "has_preview": bool(j["preview_path"]),
        "publish": json.loads(j["publish"]) if j["publish"] else None,
        "youtube_id": j["youtube_id"], "created_at": j["created_at"],
        "stage": j["stage"] or "preview", "edit": json.loads(j["edit"]) if j["edit"] else None,
        "converting_edit_ok": j["conv_edit"] == j["edit"],
        "out_info": json.loads(j["out_info"]) if j["out_info"] else None,
        "ocr_title": j["ocr_title"] or "", "watermark": bool(j["watermark"]),
        "src_quality": j["src_quality"] or "",
    }


@app.get("/api/jobs")
def jobs():
    return [_job_out(j) for j in db.list_jobs()]


@app.post("/api/jobs")
def new_job(body: NewJob):
    return {"id": pipeline.add(body.url)}


@app.post("/api/jobs/{jid}/publish")
def publish(jid: str, body: PublishIn):
    _check_job(jid)
    _check_channel(body.channel_id)
    return {"message": pipeline.publish(jid, body.model_dump())}


@app.post("/api/jobs/{jid}/retry")
def retry(jid: str):
    _check_job(jid)
    pipeline.retry(jid)
    return {"ok": True}


@app.delete("/api/jobs/{jid}")
def delete_job(jid: str):
    _check_job(jid)
    pipeline.remove(jid)
    return {"ok": True}


def _safe_file(p: str | None) -> Path:
    if not p:
        raise HTTPException(404)
    path = Path(p).resolve()
    if path.parent != VIDEOS.resolve() or not path.exists():
        raise HTTPException(404)
    return path


@app.get("/api/jobs/{jid}/thumb")
def job_thumb(jid: str):
    return FileResponse(_safe_file(_check_job(jid)["thumb_path"]), media_type="image/jpeg")


@app.get("/api/jobs/{jid}/video")
def job_video(jid: str):
    return FileResponse(_safe_file(_check_job(jid)["output_path"]), media_type="video/mp4")


@app.get("/api/jobs/{jid}/preview")
def job_preview(jid: str):
    return FileResponse(_safe_file(_check_job(jid)["preview_path"]), media_type="video/mp4")


class EditIn(BaseModel):
    start: float = Field(default=0, ge=0, le=36000)
    end: float | None = Field(default=None, ge=0, le=36000)
    cuts: list[tuple[float, float]] = Field(default_factory=list, max_length=50)

    @field_validator("cuts")
    @classmethod
    def cuts_ok(cls, v):
        for a, b in v:
            if a < 0 or b <= a:
                raise ValueError("Coupe invalide : la fin doit etre apres le debut")
        return v


@app.post("/api/jobs/{jid}/validate")
def job_validate(jid: str, body: EditIn):
    _check_job(jid)
    pipeline.validate(jid, body.model_dump())
    return {"ok": True}


@app.post("/api/jobs/{jid}/back")
def job_back(jid: str):
    _check_job(jid)
    pipeline.back_to_preview(jid)
    return {"ok": True}


@app.post("/api/jobs/{jid}/unsubmit")
def job_unsubmit(jid: str):
    _check_job(jid)
    pipeline.unsubmit(jid)
    return {"ok": True}


@app.get("/api/jobs/{jid}/suggestions")
async def job_suggestions(jid: str, channel_id: str, text: str = "", refresh: bool = False):
    job = _check_job(jid)
    _check_channel(channel_id)
    if job["suggestions"] and not refresh:
        return json.loads(job["suggestions"])
    existing = json.loads(job["src_hashtags"] or "[]")
    res = await run_in_threadpool(youtube.suggest_hashtags, channel_id, text[:300] or job["ocr_title"] or job["src_title"], existing)
    db.update_job(jid, suggestions=json.dumps(res))
    return res


# --- API : videos en ligne ------------------------------------------------------

VIDEO_RE = re.compile(r"^[\w-]{11}$")


def _check_video(vid: str):
    if not VIDEO_RE.match(vid):
        raise HTTPException(404, "Video introuvable")


class VideoPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=5000)
    tags: list[str] | None = Field(default=None, max_length=60)
    privacy: Literal["public", "unlisted", "private"] | None = None
    publish_at: str | None = None

    @field_validator("title", "description")
    @classmethod
    def no_angle(cls, v):
        if v is not None and ("<" in v or ">" in v):
            raise ValueError("Les caracteres < et > sont interdits par YouTube")
        return v

    @field_validator("tags")
    @classmethod
    def tags_ok(cls, v):
        return None if v is None else _clean_tags(v)

    @field_validator("publish_at")
    @classmethod
    def future(cls, v):
        return _future_utc(v)


@app.get("/api/eligibility/{cid}")
async def eligibility(cid: str):
    _check_channel(cid)
    return await run_in_threadpool(youtube.eligibility, cid)


@app.get("/api/videos/{cid}")
async def videos(cid: str):
    _check_channel(cid)
    return await run_in_threadpool(youtube.list_videos, cid)


@app.patch("/api/videos/{cid}/{vid}")
async def video_patch(cid: str, vid: str, body: VideoPatch):
    _check_channel(cid)
    _check_video(vid)
    return await run_in_threadpool(youtube.update_video, cid, vid, body.model_dump())


@app.delete("/api/videos/{cid}/{vid}")
async def video_delete(cid: str, vid: str):
    _check_channel(cid)
    _check_video(vid)
    await run_in_threadpool(youtube.delete_video, cid, vid)
    return {"ok": True}


@app.get("/api/videos/{cid}/{vid}/stats")
async def video_stats(cid: str, vid: str, days: int = 0):
    _check_channel(cid)
    _check_video(vid)
    if days not in (0, 7, 28, 90, 365):
        raise HTTPException(400, "Periode invalide")
    return await run_in_threadpool(youtube.video_stats, cid, vid, days)


# --- API : statistiques / profil ---------------------------------------------

@app.get("/api/stats/{cid}")
async def stats(cid: str, days: int = 28):
    _check_channel(cid)
    if days not in (7, 28, 90, 365):
        raise HTTPException(400, "Periode invalide")
    return await run_in_threadpool(youtube.stats, cid, days)


class ProfileIn(BaseModel):
    description: str = Field(default="", max_length=1000)
    keywords: str = Field(default="", max_length=500)
    country: str = Field(default="", pattern=r"^([A-Z]{2})?$")

    @field_validator("description", "keywords")
    @classmethod
    def no_angle(cls, v):
        if "<" in v or ">" in v:
            raise ValueError("Les caracteres < et > sont interdits par YouTube")
        return v


@app.get("/api/profile/{cid}")
async def profile(cid: str):
    _check_channel(cid)
    return await run_in_threadpool(youtube.get_profile, cid)


@app.put("/api/profile/{cid}")
async def update_profile(cid: str, body: ProfileIn):
    _check_channel(cid)
    await run_in_threadpool(youtube.update_profile, cid, body.description, body.keywords, body.country)
    return {"ok": True}


# --- API : cookies (videos reservees aux comptes connectes) ---------------------

def _cookie_domains(text: str) -> list[str]:
    doms = set()
    for line in text.splitlines():
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_"):]
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) == 7:
            doms.add(parts[0].lstrip("."))
    return sorted(doms)


@app.get("/api/cookies")
def cookies_status():
    if not COOKIES_FILE.exists():
        return {"present": False}
    text = COOKIES_FILE.read_text(encoding="utf-8", errors="ignore")
    sites = sorted({d.split(".")[-2] for d in _cookie_domains(text) if d.count(".") >= 1})
    return {"present": True, "updated": COOKIES_FILE.stat().st_mtime, "sites": sites}


@app.post("/api/cookies")
async def cookies_upload(file: UploadFile = File(...)):
    data = await file.read(5 * 1024 * 1024 + 1)
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(400, "Fichier trop lourd (5 Mo max)")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as e:
        raise HTTPException(400, "Ce n'est pas un fichier cookies.txt (texte)") from e
    if not _cookie_domains(text):
        raise HTTPException(400, "Format non reconnu : exporte les cookies au format Netscape (cookies.txt)")
    tmp = COOKIES_FILE.with_suffix(".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(COOKIES_FILE)
    return cookies_status()


@app.delete("/api/cookies")
def cookies_delete():
    COOKIES_FILE.unlink(missing_ok=True)
    return {"present": False}


@app.post("/api/profile/{cid}/banner")
async def update_banner(cid: str, file: UploadFile = File(...)):
    _check_channel(cid)
    data = await file.read(20 * 1024 * 1024 + 1)
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(400, "Image trop lourde (20 Mo max)")
    if not (data[:3] == b"\xff\xd8\xff" or data[:8] == b"\x89PNG\r\n\x1a\n" or data[8:12] == b"WEBP"):
        raise HTTPException(400, "Format accepte : JPG, PNG ou WEBP")
    with tempfile.TemporaryDirectory() as td:
        src, out = Path(td) / "in", Path(td) / "banner.jpg"
        src.write_bytes(data)
        # Recadre en 16:9 et redimensionne en 2560x1440 (format recommande par YouTube).
        r = subprocess.run(
            [convert.FFMPEG, "-y", "-v", "error", "-i", str(src), "-frames:v", "1", "-vf",
             "scale=2560:1440:force_original_aspect_ratio=increase,crop=2560:1440", "-q:v", "3", str(out)],
            capture_output=True, creationflags=convert.NO_WINDOW, timeout=60,
        )
        if r.returncode != 0 or not out.exists():
            raise HTTPException(400, "Image illisible")
        await run_in_threadpool(youtube.update_banner, cid, str(out))
    return {"ok": True}


app.mount("/static", StaticFiles(directory=STATIC), name="static")
