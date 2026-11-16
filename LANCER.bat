@echo off
chcp 65001 >nul
title AUTO YTB
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Premiere installation, patiente une minute...
    python -m venv .venv || (echo Python introuvable : installe-le depuis python.org & pause & exit /b 1)
    ".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt || (echo Echec de l'installation & pause & exit /b 1)
)

rem Installe les modules ajoutes depuis la derniere fois, et met a jour yt-dlp
rem (les sites changent souvent, une vieille version finit par ne plus marcher)
".venv\Scripts\python.exe" -m pip install -q -r requirements.txt >nul 2>&1
".venv\Scripts\python.exe" -m pip install -q --upgrade "yt-dlp[default,curl-cffi]" >nul 2>&1

".venv\Scripts\python.exe" run.py
pause
