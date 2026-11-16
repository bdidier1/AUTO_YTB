"""Conversion 4K 60 i/s, reprise de script_4k_shorts/convertir_4k.ps1.

- sortie 2160x3840 (9:16, format Shorts), 60 images/s constant
- bandes noires en haut/bas uniquement si la source n'est pas deja en 9:16
- une source deja en 2160x3840 @ 60 i/s (sans decoupage) est simplement remuxee
- decoupage optionnel : garder de `start` a `end`, en retirant les passages `cuts`
- GPU (NVENC / QuickSync / AMF) si utilisable, sinon CPU libx264
"""
import json
import os
import shutil
import subprocess
import threading
from pathlib import Path

from .config import TARGET_FPS, TARGET_H, TARGET_W

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _find_tool(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    base = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Packages"
    if base.exists():
        for p in base.rglob(f"{name}.exe"):
            return str(p)
    return None


FFMPEG = _find_tool("ffmpeg")
FFPROBE = _find_tool("ffprobe")

_ENCODERS = [
    ("GPU NVIDIA (NVENC)", ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr",
                             "-cq", "19", "-b:v", "0", "-maxrate", "100M", "-bufsize", "200M"]),
    ("GPU Intel (QuickSync)", ["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "19"]),
    ("GPU AMD (AMF)", ["-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", "18", "-qp_p", "20"]),
]
_CPU = ("CPU (libx264)", ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"])
_COMMON = ["-profile:v", "high", "-level", "5.2", "-pix_fmt", "yuv420p"]

_encoder_cache = None
_procs: dict[str, subprocess.Popen] = {}
_cancelled: set[str] = set()
_procs_lock = threading.Lock()


class Cancelled(Exception):
    pass


def pick_encoder():
    """Teste les encodeurs materiels en 4K60 et garde le premier qui fonctionne."""
    global _encoder_cache
    if _encoder_cache:
        return _encoder_cache
    if not FFMPEG:
        raise RuntimeError("ffmpeg introuvable. Installe-le avec : winget install Gyan.FFmpeg")
    for name, args in _ENCODERS:
        r = subprocess.run(
            [FFMPEG, "-y", "-v", "quiet", "-f", "lavfi",
             "-i", f"color=c=black:s={TARGET_W}x{TARGET_H}:d=0.2:r={TARGET_FPS}",
             *args, *_COMMON, "-f", "null", "-"],
            capture_output=True, creationflags=NO_WINDOW, timeout=60,
        )
        if r.returncode == 0:
            _encoder_cache = (name, args)
            return _encoder_cache
    _encoder_cache = _CPU
    return _encoder_cache


def probe(path: Path) -> dict:
    r = subprocess.run(
        [FFPROBE, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, creationflags=NO_WINDOW, timeout=60,
    )
    if r.returncode != 0:
        raise RuntimeError("Fichier video illisible")
    data = json.loads(r.stdout)
    v = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    if not v:
        raise RuntimeError("Aucune piste video dans le fichier")
    fps = 0.0
    rate = v.get("avg_frame_rate") or v.get("r_frame_rate") or "0/1"
    try:
        n, d = rate.split("/")
        fps = float(n) / float(d) if float(d) else 0.0
    except ValueError:
        pass
    # rotation (videos de telephone) : on inverse largeur/hauteur si besoin
    w, h = int(v["width"]), int(v["height"])
    rot = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = abs(int(sd["rotation"]))
    if rot in (90, 270):
        w, h = h, w
    return {
        "width": w, "height": h, "fps": round(fps, 3),
        "duration": float(data.get("format", {}).get("duration") or 0),
        "has_audio": any(s.get("codec_type") == "audio" for s in data.get("streams", [])),
        "vcodec": v.get("codec_name"),
    }


def _run(args, timeout=120):
    return subprocess.run([FFMPEG, "-y", "-v", "error", *args], capture_output=True,
                          creationflags=NO_WINDOW, timeout=timeout)


def thumbnail(src: Path, dest: Path):
    _run(["-ss", "0.5", "-i", str(src), "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4", str(dest)])


def frame(src: Path, t: float, dest: Path, vf: str = "scale=-2:1280:flags=lanczos"):
    """Extrait une image a l'instant t (pour l'OCR)."""
    _run(["-ss", f"{t:.2f}", "-i", str(src), "-frames:v", "1", "-vf", vf, str(dest)])
    return dest.exists()


def preview(src: Path, dest: Path):
    """Petite copie legere (H.264 960 px) lisible par tous les navigateurs, pour l'apercu."""
    r = _run(["-i", str(src), "-map", "0:v:0", "-map", "0:a:0?",
              "-vf", "scale='if(gt(iw,ih),960,-2)':'if(gt(iw,ih),-2,960)',format=yuv420p",
              "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-g", "30",
              "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(dest)], timeout=900)
    if r.returncode != 0:
        raise RuntimeError("Impossible de creer l'apercu")


# --- Decoupage ---------------------------------------------------------------

def keep_segments(edit: dict | None, duration: float) -> list[tuple[float, float]]:
    """Passages conserves, a partir de {start, end, cuts:[[a,b],...]}."""
    start = max(0.0, float((edit or {}).get("start") or 0))
    end = float((edit or {}).get("end") or duration) or duration
    end = min(end, duration) if duration else end
    segs = [(start, end)]
    for a, b in sorted((float(a), float(b)) for a, b in (edit or {}).get("cuts") or []):
        out = []
        for s, e in segs:
            if b <= s or a >= e:
                out.append((s, e))
                continue
            if a > s:
                out.append((s, a))
            if b < e:
                out.append((b, e))
        segs = out
    return [(round(s, 3), round(e, 3)) for s, e in segs if e - s >= 0.05]


def is_full(segs, duration) -> bool:
    return len(segs) == 1 and segs[0][0] <= 0.05 and segs[0][1] >= duration - 0.05


# --- Execution avec progression et annulation --------------------------------

def cancel(key: str):
    with _procs_lock:
        _cancelled.add(key)
        p = _procs.get(key)
    if p and p.poll() is None:
        p.kill()


def _run_with_progress(cmd, duration, on_progress, key):
    with _procs_lock:
        if key in _cancelled:
            _cancelled.discard(key)
            raise Cancelled()
        proc = subprocess.Popen(
            [*cmd[:1], "-progress", "pipe:1", "-nostats", *cmd[1:]],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, creationflags=NO_WINDOW,
        )
        _procs[key] = proc
    err = []
    t = threading.Thread(target=lambda: err.append(proc.stderr.read()), daemon=True)
    t.start()
    for line in proc.stdout:
        if line.startswith("out_time_us=") and duration > 0:
            try:
                on_progress(min(99.0, int(line.split("=", 1)[1]) / 1e6 / duration * 100))
            except ValueError:
                pass
    proc.wait()
    t.join(5)
    with _procs_lock:
        _procs.pop(key, None)
        if key in _cancelled:
            _cancelled.discard(key)
            raise Cancelled()
    return proc.returncode, (err[0] if err else "")


def convert(src: Path, dest: Path, info: dict, on_progress=lambda p: None,
            edit: dict | None = None, key: str = "") -> str:
    """Convertit src en 4K60 vertical vers dest. Renvoie une description de ce qui a ete fait."""
    tmp = dest.with_name(".tmp_" + dest.name)
    w, h, fps, dur = info["width"], info["height"], info["fps"], info["duration"]
    segs = keep_segments(edit, dur)
    if not segs:
        raise RuntimeError("Le decoupage ne garde aucun passage de la video")
    full = is_full(segs, dur)
    out_dur = sum(e - s for s, e in segs)

    if full and w == TARGET_W and h == TARGET_H and abs(fps - TARGET_FPS) < 0.5 and info["vcodec"] in ("h264", "hevc"):
        code, _ = _run_with_progress(
            [FFMPEG, "-y", "-v", "error", "-i", str(src), "-map", "0:v:0", "-map", "0:a:0?",
             "-c", "copy", "-movflags", "+faststart", str(tmp)], dur, on_progress, key)
        if code == 0:
            tmp.replace(dest)
            return "Deja en 4K 60 i/s : copie sans re-encodage"

    same_ratio = abs(round(w / h, 4) - round(TARGET_W / TARGET_H, 4)) < 0.002
    vf = f"fps={TARGET_FPS},"
    af = []
    if not full:
        expr = "+".join(f"between(t,{s:.3f},{e:.3f})" for s, e in segs)
        vf += f"select='{expr}',setpts=N/({TARGET_FPS}*TB),"
        if info.get("has_audio"):
            af = ["-af", f"aselect='{expr}',asetpts=N/SR/TB"]
    vf += (
        f"scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,"
        f"pad={TARGET_W}:{TARGET_H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p"
    )
    enc_name, enc_args = pick_encoder()

    def run(args):
        return _run_with_progress(
            [FFMPEG, "-y", "-v", "error", "-i", str(src), "-map", "0:v:0", "-map", "0:a:0?",
             "-vf", vf, *af, "-fps_mode", "cfr", *args, *_COMMON,
             "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
             "-movflags", "+faststart", str(tmp)],
            out_dur, on_progress, key)

    try:
        code, err = run(enc_args)
        if code != 0 and enc_args is not _CPU[1]:
            enc_name, enc_args = _CPU      # le GPU a echoue en cours de route : on retente au CPU
            code, err = run(enc_args)
    except Cancelled:
        tmp.unlink(missing_ok=True)
        raise
    if code != 0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError("Echec ffmpeg : " + (err.strip().splitlines() or ["erreur inconnue"])[-1][:300])

    tmp.replace(dest)
    what = "upscale 4K" if same_ratio else "upscale 4K + bandes noires"
    if not full:
        what += f", decoupee a {out_dur:.1f} s"
    return f"{w}x{h} @ {fps:g} i/s -> {TARGET_W}x{TARGET_H} @ {TARGET_FPS} i/s ({what}, {enc_name})"
