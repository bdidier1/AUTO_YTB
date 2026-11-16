"""Connexion OAuth, envoi de videos, statistiques et profil YouTube."""
import json
import os
import random
import re
import secrets
import threading
import time
from datetime import date, datetime, timedelta, timezone

# L'utilisateur peut decocher une autorisation (ex. revenus) sur l'ecran Google.
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")

from google.auth.exceptions import RefreshError  # noqa: E402
from google.auth.transport.requests import Request  # noqa: E402
from google.oauth2.credentials import Credentials  # noqa: E402
from google_auth_oauthlib.flow import Flow  # noqa: E402
from googleapiclient.discovery import build  # noqa: E402
from googleapiclient.errors import HttpError  # noqa: E402
from googleapiclient.http import MediaFileUpload  # noqa: E402

from . import db  # noqa: E402
from .config import CLIENT_SECRET, REDIRECT_URI, SCOPES  # noqa: E402


class YTError(Exception):
    """Erreur affichable telle quelle a l'utilisateur."""


class ReauthError(YTError):
    """L'acces Google du compte a expire ou a ete revoque : il faut reconnecter le compte."""


REAUTH_MSG = ("Google a coupe l'acces a ce compte (autorisation expiree ou revoquee). "
              "Clique sur « Reconnecter » pour le reconnecter.")


# --- OAuth -------------------------------------------------------------------

_pending: dict[str, tuple[Flow, float]] = {}
_pending_lock = threading.Lock()


def _secret_path():
    """data/client_secret.json, ou a defaut tout client_secret*.json (ex. nom double .json.json)."""
    if CLIENT_SECRET.exists():
        return CLIENT_SECRET
    return next(iter(sorted(CLIENT_SECRET.parent.glob("client_secret*.json"))), None)


def client_configured() -> bool:
    return _secret_path() is not None


def start_auth() -> str:
    if not client_configured():
        raise YTError("Fichier data/client_secret.json manquant (voir LISEZMOI).")
    flow = Flow.from_client_secrets_file(
        str(_secret_path()), scopes=SCOPES, redirect_uri=REDIRECT_URI,
        autogenerate_code_verifier=True,  # PKCE
    )
    state = secrets.token_urlsafe(32)
    url, _ = flow.authorization_url(
        access_type="offline", prompt="consent select_account", state=state,
    )
    with _pending_lock:
        now = time.time()
        for k in [k for k, (_, t) in _pending.items() if now - t > 600]:
            del _pending[k]
        _pending[state] = (flow, now)
    return url


def finish_auth(state: str, code: str) -> dict:
    with _pending_lock:
        item = _pending.pop(state, None)
    if not item or time.time() - item[1] > 600:
        raise YTError("Session de connexion expiree ou invalide. Recommence.")
    flow = item[0]
    try:
        flow.fetch_token(code=code)
    except Exception as e:  # noqa: BLE001
        raise YTError(f"Echange du code refuse par Google : {e}") from e
    creds = flow.credentials
    yt = build("youtube", "v3", credentials=creds, cache_discovery=False)
    items = yt.channels().list(part="snippet", mine=True).execute().get("items", [])
    if not items:
        raise YTError("Ce compte Google n'a pas de chaine YouTube. Cree-la d'abord sur youtube.com.")
    ch = items[0]
    thumb = ch["snippet"].get("thumbnails", {}).get("default", {}).get("url", "")
    db.save_account(ch["id"], ch["snippet"]["title"], thumb, _creds_to_dict(creds))
    return {"channel_id": ch["id"], "title": ch["snippet"]["title"]}


def _creds_to_dict(c: Credentials) -> dict:
    return {
        "token": c.token, "refresh_token": c.refresh_token, "token_uri": c.token_uri,
        "client_id": c.client_id, "client_secret": c.client_secret,
        "scopes": list(c.granted_scopes or c.scopes or SCOPES),
        "expiry": c.expiry.isoformat() if c.expiry else None,
    }


_refresh_lock = threading.Lock()


def get_creds(channel_id: str) -> Credentials:
    with _refresh_lock:
        data = db.get_account_creds(channel_id)
        if not data:
            raise YTError("Compte inconnu.")
        creds = Credentials(
            token=data["token"], refresh_token=data["refresh_token"], token_uri=data["token_uri"],
            client_id=data["client_id"], client_secret=data["client_secret"], scopes=data["scopes"],
            # sans date d'expiration, le jeton ne serait jamais renouvele a l'avance
            expiry=datetime.fromisoformat(data["expiry"]) if data.get("expiry") else datetime(2000, 1, 1),
        )
        if not creds.valid:
            try:
                creds.refresh(Request())
            except RefreshError as e:
                raise ReauthError(REAUTH_MSG) from e
            db.update_account_creds(channel_id, _creds_to_dict(creds))
        return creds


def _yt(channel_id):
    return build("youtube", "v3", credentials=get_creds(channel_id), cache_discovery=False)


def _analytics(channel_id):
    return build("youtubeAnalytics", "v2", credentials=get_creds(channel_id), cache_discovery=False)


def http_error_message(e: HttpError) -> str:
    try:
        err = json.loads(e.content.decode())["error"]
        reason = (err.get("errors") or [{}])[0].get("reason", "")
        msg = err.get("message", str(e))
    except Exception:  # noqa: BLE001
        return str(e)
    hints = {
        "quotaExceeded": "Quota journalier de l'API atteint (remis a zero vers 9h, heure de Paris).",
        "uploadLimitExceeded": "Limite d'envois YouTube atteinte pour aujourd'hui sur cette chaine.",
        "youtubeSignupRequired": "Ce compte n'a pas de chaine YouTube.",
        "invalidPublishAt": "Date de publication invalide (elle doit etre dans le futur).",
    }
    return hints.get(reason, msg)


# --- Envoi -------------------------------------------------------------------

RETRY_STATUS = {500, 502, 503, 504}


def upload(channel_id: str, path: str, meta: dict, on_progress=lambda p: None) -> str:
    """Envoie la video. meta: title, description, tags, privacy, publish_at (ISO UTC ou None)."""
    status = {"selfDeclaredMadeForKids": False}
    if meta.get("publish_at"):
        status["privacyStatus"] = "private"      # obligatoire pour une publication programmee
        status["publishAt"] = meta["publish_at"]
    else:
        status["privacyStatus"] = meta.get("privacy", "public")
    body = {
        "snippet": {
            "title": meta["title"], "description": meta["description"],
            "tags": meta["tags"], "categoryId": meta.get("category", "22"),
        },
        "status": status,
    }
    media = MediaFileUpload(path, mimetype="video/mp4", chunksize=16 * 1024 * 1024, resumable=True)
    req = _yt(channel_id).videos().insert(part="snippet,status", body=body, media_body=media)

    response, retries = None, 0
    while response is None:
        try:
            st, response = req.next_chunk()
            if st:
                on_progress(st.progress() * 100)
            retries = 0
        except HttpError as e:
            if e.resp.status in RETRY_STATUS and retries < 8:
                retries += 1
                time.sleep(min(60, 2 ** retries + random.random()))
                continue
            raise YTError(http_error_message(e)) from e
        except (ConnectionError, TimeoutError, OSError) as e:
            if retries < 8:
                retries += 1
                time.sleep(min(60, 2 ** retries + random.random()))
                continue
            raise YTError("Connexion perdue pendant l'envoi.") from e
    on_progress(100)
    return response["id"]


# --- Statistiques ------------------------------------------------------------

_ISO_DUR = re.compile(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?")


def _iso_seconds(d: str) -> int:
    m = _ISO_DUR.fullmatch(d or "")
    if not m:
        return 0
    dd, hh, mm, ss = (int(x or 0) for x in m.groups())
    return dd * 86400 + hh * 3600 + mm * 60 + ss


def _video_dict(v: dict) -> dict:
    st, sn, stat = v.get("statistics", {}), v["snippet"], v.get("status", {})
    cd = v.get("contentDetails", {})
    thumbs = sn.get("thumbnails", {})
    rr = cd.get("regionRestriction", {})
    return {
        "id": v["id"], "title": sn.get("title", ""), "description": sn.get("description", ""),
        "tags": sn.get("tags", []), "published": sn.get("publishedAt", ""),
        "thumb": (thumbs.get("medium") or thumbs.get("default") or {}).get("url", ""),
        "privacy": stat.get("privacyStatus", ""), "publish_at": stat.get("publishAt"),
        "upload_status": stat.get("uploadStatus", ""), "rejection": stat.get("rejectionReason"),
        "failure": stat.get("failureReason"), "made_for_kids": stat.get("madeForKids", False),
        "duration": _iso_seconds(cd.get("duration", "")),
        "blocked": rr.get("blocked", []), "allowed": rr.get("allowed"),
        "views": int(st.get("viewCount", 0)), "likes": int(st.get("likeCount", 0)),
        "comments": int(st.get("commentCount", 0)),
    }


def _upload_ids(yt, uploads_playlist: str, limit: int) -> list[str]:
    ids, token = [], None
    try:
        while len(ids) < limit:
            page = yt.playlistItems().list(part="contentDetails", playlistId=uploads_playlist,
                                           maxResults=50, pageToken=token).execute()
            ids += [i["contentDetails"]["videoId"] for i in page.get("items", [])]
            token = page.get("nextPageToken")
            if not token:
                break
    except HttpError:
        return []   # chaine sans video : la playlist n'existe pas encore
    return ids[:limit]


def _live_videos(yt, uploads_playlist: str, limit: int = 500) -> list[dict]:
    """Videos de la chaine (plus recentes d'abord) avec les compteurs en direct affiches sur YouTube."""
    ids = _upload_ids(yt, uploads_playlist, limit)
    out = []
    for i in range(0, len(ids), 50):
        items = yt.videos().list(part="snippet,statistics,status,contentDetails",
                                 id=",".join(ids[i:i + 50])).execute().get("items", [])
        out += [_video_dict(v) for v in items]
    out.sort(key=lambda v: v["publish_at"] or v["published"], reverse=True)
    return out


def stats(channel_id: str, days: int) -> dict:
    yt = _yt(channel_id)
    items = yt.channels().list(part="snippet,statistics,contentDetails", id=channel_id).execute().get("items", [])
    if not items:
        raise YTError("Chaine introuvable.")
    ch = items[0]
    s = ch["statistics"]
    live = _live_videos(yt, ch["contentDetails"]["relatedPlaylists"]["uploads"])
    out = {
        "totals": {
            "subscribers": None if s.get("hiddenSubscriberCount") else int(s.get("subscriberCount", 0)),
            # Le total de la chaine est mis a jour avec du retard : on prend la somme des
            # compteurs en direct des videos si elle est plus haute.
            "views": max(int(s.get("viewCount", 0)), sum(v["views"] for v in live)),
            "videos": max(int(s.get("videoCount", 0)), sum(1 for v in live if v["privacy"] == "public")),
        },
        "recent": live[:10],
        "series": [], "top": [], "revenue_available": True, "note": "",
    }
    db.update_account_meta(channel_id, ch["snippet"]["title"],
                           ch["snippet"].get("thumbnails", {}).get("default", {}).get("url", ""))

    end = date.today()
    start = end - timedelta(days=days - 1)
    an = _analytics(channel_id)
    base = "views,estimatedMinutesWatched,subscribersGained,subscribersLost,likes,comments"
    common = dict(ids="channel==MINE", startDate=start.isoformat(), endDate=end.isoformat())
    try:
        rep = an.reports().query(metrics=base + ",estimatedRevenue", dimensions="day", sort="day",
                                 currency="EUR", **common).execute()
    except HttpError:
        out["revenue_available"] = False
        out["note"] = ("Revenus indisponibles : la chaine n'est pas monetisee (Programme Partenaire YouTube) "
                       "ou l'autorisation « revenus » n'a pas ete cochee a la connexion.")
        try:
            rep = an.reports().query(metrics=base, dimensions="day", sort="day", **common).execute()
        except HttpError as e:
            raise YTError(http_error_message(e)) from e
    cols = [h["name"] for h in rep.get("columnHeaders", [])]
    out["series"] = [dict(zip(cols, row)) for row in rep.get("rows", []) or []]

    try:
        top = an.reports().query(metrics="views,estimatedMinutesWatched,likes", dimensions="video",
                                 sort="-views", maxResults=10, **common).execute()
        rows = top.get("rows", []) or []
        if rows:
            vids = yt.videos().list(part="snippet", id=",".join(r[0] for r in rows)).execute().get("items", [])
            info = {v["id"]: v["snippet"] for v in vids}
            for r in rows:
                sn = info.get(r[0], {})
                out["top"].append({
                    "id": r[0], "title": sn.get("title", r[0]),
                    "thumb": sn.get("thumbnails", {}).get("default", {}).get("url", ""),
                    "views": r[1], "minutes": r[2], "likes": r[3],
                })
    except HttpError:
        pass
    return out


# --- Profil ------------------------------------------------------------------

def _channel(yt, channel_id, part):
    items = yt.channels().list(part=part, id=channel_id).execute().get("items", [])
    if not items:
        raise YTError("Chaine introuvable.")
    return items[0]


def get_profile(channel_id: str) -> dict:
    ch = _channel(_yt(channel_id), channel_id, "snippet,brandingSettings,statistics")
    sn, br = ch["snippet"], ch.get("brandingSettings", {})
    bc = br.get("channel", {})
    thumbs = sn.get("thumbnails", {})
    return {
        "id": ch["id"],
        "title": sn["title"],
        "custom_url": sn.get("customUrl", ""),
        "description": bc.get("description", sn.get("description", "")),
        "keywords": bc.get("keywords", ""),
        "country": bc.get("country", sn.get("country", "")) or "",
        "avatar": (thumbs.get("high") or thumbs.get("medium") or thumbs.get("default") or {}).get("url", ""),
        "banner": br.get("image", {}).get("bannerExternalUrl", ""),
        "subscribers": ch.get("statistics", {}).get("subscriberCount"),
        "studio_url": f"https://studio.youtube.com/channel/{ch['id']}/editing/profile",
    }


def update_profile(channel_id: str, description: str, keywords: str, country: str) -> None:
    yt = _yt(channel_id)
    br = _channel(yt, channel_id, "brandingSettings").get("brandingSettings", {})
    chan = br.setdefault("channel", {})
    chan["description"] = description
    chan["keywords"] = keywords
    if country:
        chan["country"] = country
    else:
        chan.pop("country", None)
    try:
        yt.channels().update(part="brandingSettings", body={"id": channel_id, "brandingSettings": br}).execute()
    except HttpError as e:
        raise YTError(http_error_message(e)) from e


def update_banner(channel_id: str, jpg_path: str) -> None:
    yt = _yt(channel_id)
    try:
        res = yt.channelBanners().insert(media_body=MediaFileUpload(jpg_path, mimetype="image/jpeg")).execute()
        br = _channel(yt, channel_id, "brandingSettings").get("brandingSettings", {})
        br.setdefault("image", {})["bannerExternalUrl"] = res["url"]
        yt.channels().update(part="brandingSettings", body={"id": channel_id, "brandingSettings": br}).execute()
    except HttpError as e:
        raise YTError(http_error_message(e)) from e


# --- Suggestions de hashtags ---------------------------------------------------

_STOP = set("""a au aux avec ce ces cette dans de des du elle en et eux il ils je la le les leur lui ma mais me meme
mes moi mon ne nos notre nous on ou par pas pour qu que qui sa se ses son sur ta te tes toi ton tu un une vos votre
vous c d j l m n s t y ete etre avoir fait faire quand comme tout tous toute plus moins tres bien quoi alors donc
est sont suis va vais the and for you your with this that pov lol mdr""".split())
POPULAR_FR = ["shorts", "pov", "humour", "drole", "viral", "pourtoi", "tendance", "memes", "fyp", "france"]


def _keywords(text: str, n: int = 5) -> list[str]:
    words = re.findall(r"[^\W\d_]{4,}", (text or "").lower())
    out = []
    for w in words:
        if w not in _STOP and w not in out:
            out.append(w)
    return out[:n]


def suggest_hashtags(channel_id: str, text: str, existing: list[str]) -> dict:
    """Hashtags les plus utilises par les Shorts proches (recherche YouTube), hors ceux deja mis."""
    have = {h.lower() for h in existing}
    words = _keywords(text, 4)
    words += [h.lower() for h in existing[:3] if h.lower() not in words]
    query = " ".join(words[:6])
    related = []
    if query:
        yt = _yt(channel_id)
        try:
            res = yt.search().list(part="id", q=query, type="video", videoDuration="short", maxResults=25,
                                   regionCode="FR", relevanceLanguage="fr").execute()
            ids = [i["id"]["videoId"] for i in res.get("items", []) if i.get("id", {}).get("videoId")]
            counts: dict[str, list] = {}
            if ids:
                for v in yt.videos().list(part="snippet", id=",".join(ids)).execute().get("items", []):
                    sn = v["snippet"]
                    found = set(re.findall(r"#(\w+)", sn.get("title", "") + " " + sn.get("description", "")))
                    found |= {t for t in sn.get("tags", []) if re.fullmatch(r"\w{2,40}", t)}
                    seen_here = set()
                    for t in found:
                        k = t.lower()
                        if k in have or k.isdigit() or k in seen_here:
                            continue
                        seen_here.add(k)
                        counts.setdefault(k, [t, 0])[1] += 1
            ranked = sorted(counts.values(), key=lambda x: -x[1])
            related = [t for t, c in ranked if c >= 2][:15]
            if len(related) < 6:   # peu de recoupements : on complete avec les plus pertinents
                related += [t for t, c in ranked if c == 1 and t not in related][:10 - len(related)]
        except HttpError as e:
            raise YTError(http_error_message(e)) from e
    rel = {r.lower() for r in related}
    popular = [t for t in POPULAR_FR if t not in have and t not in rel]
    return {"query": query, "related": related, "popular": popular}


# --- Eligibilite a la monetisation -------------------------------------------

_elig_cache: dict[str, tuple[float, dict]] = {}


def eligibility(channel_id: str) -> dict:
    """Progression vers le Programme Partenaire YouTube (seuils officiels)."""
    cached = _elig_cache.get(channel_id)
    if cached and time.time() - cached[0] < 3600:
        return cached[1]
    yt, an = _yt(channel_id), _analytics(channel_id)
    ch = _channel(yt, channel_id, "statistics,contentDetails")
    subs = int(ch["statistics"].get("subscriberCount", 0))
    end = date.today()

    def by_type(days, metrics):
        rep = an.reports().query(ids="channel==MINE", startDate=(end - timedelta(days=days - 1)).isoformat(),
                                 endDate=end.isoformat(), metrics=metrics, dimensions="creatorContentType").execute()
        cols = [h["name"] for h in rep.get("columnHeaders", [])]
        return {r[0]: dict(zip(cols, r)) for r in rep.get("rows", []) or []}

    long_hours = shorts_views = None
    try:
        minutes = by_type(365, "estimatedMinutesWatched").get("VIDEO_ON_DEMAND", {}).get("estimatedMinutesWatched", 0)
        long_hours = round(minutes / 60)
        try:
            sv = by_type(90, "engagedViews").get("SHORTS", {}).get("engagedViews", 0)
        except HttpError:
            sv = by_type(90, "views").get("SHORTS", {}).get("views", 0)
        shorts_views = int(sv)
    except HttpError:
        pass
    since = (datetime.now(timezone.utc) - timedelta(days=90)).strftime("%Y-%m-%dT%H:%M:%S")
    videos = _live_videos(yt, ch["contentDetails"]["relatedPlaylists"]["uploads"], 100)
    recent_uploads = sum(1 for v in videos if v["privacy"] == "public" and v["published"][:19] >= since)
    # L'API ne dit pas si la chaine est dans le Programme Partenaire : on compare aux seuils officiels.
    hrs, sv = long_hours or 0, shorts_views or 0
    out = {"subscribers": subs, "long_hours_365": long_hours, "shorts_views_90": shorts_views,
           "public_uploads_90": recent_uploads,
           "eligible_full": subs >= 1000 and (hrs >= 4000 or sv >= 10_000_000),
           "eligible_basic": subs >= 500 and recent_uploads >= 3 and (hrs >= 3000 or sv >= 3_000_000)}
    _elig_cache[channel_id] = (time.time(), out)
    return out


# --- Videos en ligne -----------------------------------------------------------

def list_videos(channel_id: str, limit: int = 200) -> list[dict]:
    yt = _yt(channel_id)
    ch = _channel(yt, channel_id, "contentDetails")
    return _live_videos(yt, ch["contentDetails"]["relatedPlaylists"]["uploads"], limit)


def _own_video(yt, channel_id, video_id, part):
    items = yt.videos().list(part=part, id=video_id).execute().get("items", [])
    if not items or items[0]["snippet"]["channelId"] != channel_id:
        raise YTError("Video introuvable sur cette chaine.")
    return items[0]


def update_video(channel_id: str, video_id: str, ch: dict) -> dict:
    """ch : title, description, tags, privacy, publish_at (ISO UTC). Seuls les champs presents changent."""
    yt = _yt(channel_id)
    v = _own_video(yt, channel_id, video_id, "snippet,status")
    sn, st = v["snippet"], v["status"]
    body_sn = {"title": sn["title"], "description": sn.get("description", ""), "tags": sn.get("tags", []),
               "categoryId": sn.get("categoryId", "22")}
    for k in ("defaultLanguage", "defaultAudioLanguage"):
        if sn.get(k):
            body_sn[k] = sn[k]
    for k in ("title", "description", "tags"):
        if ch.get(k) is not None:
            body_sn[k] = ch[k]
    body_st = {"privacyStatus": st["privacyStatus"], "selfDeclaredMadeForKids": st.get("madeForKids", False),
               "embeddable": st.get("embeddable", True), "license": st.get("license", "youtube"),
               "publicStatsViewable": st.get("publicStatsViewable", True)}
    if ch.get("publish_at"):
        body_st["privacyStatus"] = "private"
        body_st["publishAt"] = ch["publish_at"]
    elif ch.get("privacy"):
        body_st["privacyStatus"] = ch["privacy"]        # sans publishAt : annule la programmation
    elif st.get("publishAt"):
        body_st["publishAt"] = st["publishAt"]
    try:
        res = yt.videos().update(part="snippet,status",
                                 body={"id": video_id, "snippet": body_sn, "status": body_st}).execute()
    except HttpError as e:
        raise YTError(http_error_message(e)) from e
    return {"privacy": res["status"]["privacyStatus"], "publish_at": res["status"].get("publishAt")}


def delete_video(channel_id: str, video_id: str) -> None:
    yt = _yt(channel_id)
    _own_video(yt, channel_id, video_id, "snippet")
    try:
        yt.videos().delete(id=video_id).execute()
    except HttpError as e:
        raise YTError(http_error_message(e)) from e


def video_stats(channel_id: str, video_id: str, days: int) -> dict:
    """Statistiques d'une video. days=0 : depuis la mise en ligne."""
    yt, an = _yt(channel_id), _analytics(channel_id)
    v = _video_dict(_own_video(yt, channel_id, video_id, "snippet,statistics,status,contentDetails"))
    end = date.today()
    pub = (v["publish_at"] or v["published"] or "")[:10]
    if days:
        start = end - timedelta(days=days - 1)
    else:
        start = date.fromisoformat(pub) if pub else end - timedelta(days=27)
    start = min(start, end)
    common = dict(ids="channel==MINE", filters=f"video=={video_id}",
                  startDate=start.isoformat(), endDate=end.isoformat())
    base = ("views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,"
            "likes,comments,shares,subscribersGained")

    def q(metrics, **kw):
        rep = an.reports().query(metrics=metrics, **common, **kw).execute()
        cols = [h["name"] for h in rep.get("columnHeaders", [])]
        return [dict(zip(cols, r)) for r in rep.get("rows", []) or []]

    revenue = True
    try:
        totals = q(base + ",estimatedRevenue", currency="EUR")
    except HttpError:
        revenue = False
        try:
            totals = q(base)
        except HttpError as e:
            raise YTError(http_error_message(e)) from e
    series = q("views,estimatedMinutesWatched,likes,subscribersGained", dimensions="day", sort="day")
    try:
        traffic = q("views", dimensions="insightTrafficSourceType", sort="-views")
    except HttpError:
        traffic = []
    try:
        countries = q("views", dimensions="country", sort="-views", maxResults=8)
    except HttpError:
        countries = []
    return {"video": v, "totals": totals[0] if totals else {}, "series": series, "traffic": traffic,
            "countries": countries, "revenue_available": revenue, "start": start.isoformat()}
