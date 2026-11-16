"""Chemins et constantes de l'application."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("AUTOYTB_DATA") or ROOT / "data")
VIDEOS = DATA / "videos"
STATIC = ROOT / "static"

CLIENT_SECRET = DATA / "client_secret.json"   # fichier OAuth fourni par Google
KEY_FILE = DATA / "secret.key"                # cle de chiffrement des tokens
DB_FILE = DATA / "autoytb.db"
COOKIES_FILE = DATA / "cookies.txt"           # optionnel (Instagram prive, etc.)

HOST = "127.0.0.1"
PORT = int(os.environ.get("AUTOYTB_PORT") or 8765)
BASE_URL = f"http://{HOST}:{PORT}"
REDIRECT_URI = f"{BASE_URL}/oauth/callback"

# Sortie : 4K vertical 9:16 (format Shorts), 60 images/s, comme script_4k_shorts
TARGET_W = 2160
TARGET_H = 3840
TARGET_FPS = 60

MAX_DOWNLOAD_BYTES = 2 * 1024**3  # 2 Go

SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
    "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
]

for d in (DATA, VIDEOS):
    d.mkdir(parents=True, exist_ok=True)
