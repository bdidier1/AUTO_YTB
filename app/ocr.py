"""Lecture du texte incruste dans la video (OCR integre a Windows, 100 % local)."""
import asyncio
import re
import tempfile
from pathlib import Path

from . import convert

WATERMARK_RE = re.compile(r"tik\s*to|instagram|reels|capcut|snapchat|facebook|youtube|^\s*@", re.I)


async def _ocr_file(path: str):
    from winrt.windows.globalization import Language
    from winrt.windows.graphics.imaging import BitmapDecoder
    from winrt.windows.media.ocr import OcrEngine
    from winrt.windows.storage import FileAccessMode, StorageFile

    engine = OcrEngine.try_create_from_language(Language("fr-FR")) or OcrEngine.try_create_from_user_profile_languages()
    if engine is None:
        return []
    f = await StorageFile.get_file_from_path_async(path)
    stream = await f.open_async(FileAccessMode.READ)
    bmp = await (await BitmapDecoder.create_async(stream)).get_software_bitmap_async()
    res = await engine.recognize_async(bmp)
    lines = []
    for ln in res.lines:
        words = list(ln.words)
        if not words:
            continue
        y = min(w.bounding_rect.y for w in words)
        hgt = max(w.bounding_rect.height for w in words)
        lines.append({"text": ln.text.strip(), "y": y, "h": hgt, "img_h": bmp.pixel_height})
    return lines


def _read(path: Path):
    try:
        return asyncio.run(_ocr_file(str(path.resolve())))
    except Exception:  # noqa: BLE001  (OCR indisponible : on continue sans)
        return []


def _clean(s: str) -> str:
    s = re.sub(r"\s+", " ", s).strip(" -_|•·*")
    s = s.replace("<", "").replace(">", "")
    # « TU aurais... » -> « Tu aurais... » (majuscules parasites des polices TikTok)
    words = s.split(" ")
    if words and len(words) > 1 and words[0].isupper() and len(words[0]) <= 3 and not s.isupper():
        words[0] = words[0].capitalize()
    return " ".join(words)


# Deux traitements d'image : texte blanc isole (sous-titres TikTok) et image normale.
_VARIANTS = [
    "scale=-2:1280:flags=lanczos,format=gray,lutyuv=y='if(gt(val,200),0,255)'",
    "scale=-2:1280:flags=lanczos",
]


def _block(lines):
    """Bloc de texte principal d'une image + presence d'un filigrane."""
    watermark, good = False, []
    for ln in lines:
        if WATERMARK_RE.search(ln["text"]):
            watermark = True
            continue
        letters = sum(c.isalpha() for c in ln["text"])
        if letters < 3 or ln["h"] < ln["img_h"] * 0.012:
            continue
        good.append(ln)
    if not good:
        return "", watermark
    big = max(ln["h"] for ln in good)
    block = sorted((ln for ln in good if ln["h"] >= big * 0.6), key=lambda ln: ln["y"])
    return _clean(" ".join(ln["text"] for ln in block)), watermark


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def analyse(src: Path, duration: float) -> dict:
    """Renvoie {'title': texte principal affiche au debut, 'watermark': bool}.

    Plusieurs images x plusieurs traitements : le texte lu le plus souvent l'emporte
    (une lecture ratee sur une image est ecartee par les autres)."""
    times = [t for t in (0.3, 1.0, 2.0, 3.5) if t < max(duration, 0.4)]
    watermark, votes = False, {}
    with tempfile.TemporaryDirectory() as td:
        for i, t in enumerate(times):
            for j, vf in enumerate(_VARIANTS):
                img = Path(td) / f"f{i}_{j}.png"
                if not convert.frame(src, t, img, vf):
                    continue
                text, wm = _block(_read(img))
                watermark = watermark or wm
                if text:
                    k = _norm(text)
                    if k:
                        cnt, first = votes.get(k, (0, text))
                        votes[k] = (cnt + 1, first)
    if not votes:
        return {"title": "", "watermark": watermark}
    # le plus lu ; a egalite, le plus tot dans la video (ordre d'insertion)
    best = max(votes.values(), key=lambda v: v[0])
    return {"title": best[1][:100], "watermark": watermark}
