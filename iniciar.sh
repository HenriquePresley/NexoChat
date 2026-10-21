#!/usr/bin/env bash
# NexoChat no Linux/Mac: instala as bibliotecas se precisar e reinicia sozinho se parar.
cd "$(dirname "$0")"
if [ ! -d node_modules ] || ! cmp -s package.json node_modules/.nexochat-pacotes; then
  npm install --no-audit --no-fund && cp package.json node_modules/.nexochat-pacotes
fi
while true; do node server.js; echo "NexoChat parou. Reiniciando em 5s..."; sleep 5; done
