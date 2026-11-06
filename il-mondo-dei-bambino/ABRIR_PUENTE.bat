@echo off
chcp 65001 >nul
title Puente TikTok - Il Mondo dei Bambino
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo No encuentro Python. Instalalo desde python.org y marca la casilla "Add Python to PATH".
  pause
  exit /b
)
echo Revisando librerias (la primera vez tarda un poco)...
python -m pip install --quiet --upgrade TikTokLive websockets
python puente_tiktok.py %*
pause
