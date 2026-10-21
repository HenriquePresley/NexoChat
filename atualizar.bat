@echo off
title Atualizar NexoChat
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0atualizar.ps1"
pause
