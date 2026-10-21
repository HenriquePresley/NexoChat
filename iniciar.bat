@echo off
title NexoChat
cd /d "%~dp0"

rem Atualizador sempre na versao mais nova (vem dentro de src)
if exist "src\windows\atualizar.ps1" copy /y "src\windows\atualizar.ps1" "atualizar.ps1" >nul
if exist "src\chaves.env" copy /y "src\chaves.env" "chaves.env" >nul

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale em https://nodejs.org e abra este arquivo de novo.
  pause
  exit /b
)

rem Instala as bibliotecas so na primeira vez ou quando o package.json mudar
if not exist node_modules goto instalar
fc /b package.json node_modules\.nexochat-pacotes >nul 2>nul
if errorlevel 1 goto instalar
goto iniciar

:instalar
echo.
echo Instalando bibliotecas (so acontece na primeira vez ou depois de uma atualizacao)...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo Erro ao instalar. Confira a internet e tente de novo.
  pause
  exit /b
)
copy /y package.json node_modules\.nexochat-pacotes >nul

:iniciar
rem Fecha um NexoChat que tenha ficado aberto (senao a porta 3000 fica ocupada)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0src\windows\fechar-antigo.ps1"
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0src\windows\abrir-chrome.ps1"

:loop
echo.
echo ============================================
echo   NexoChat rodando. Para desligar, feche esta janela.
echo ============================================
node server.js
echo.
if errorlevel 3 (
  echo A porta 3000 estava ocupada. Fechando o NexoChat antigo e tentando de novo...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0src\windows\fechar-antigo.ps1"
)
echo O NexoChat parou. Reiniciando em 5 segundos...
timeout /t 5 /nobreak >nul
goto loop
