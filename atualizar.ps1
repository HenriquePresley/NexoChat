# Atualiza o NexoChat a partir do zip mais recente baixado (nexochat*.zip).
# Copia tudo o que vem no zip, menos o .env, a pasta dados e as bibliotecas instaladas.
$ErrorActionPreference = 'Stop'
$destino = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $destino 'server.js'))) { $destino = $PSScriptRoot }
$locais = @("$env:USERPROFILE\Downloads", $destino, (Split-Path $destino -Parent))
$zip = Get-ChildItem -Path $locais -Filter 'nexochat*.zip' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $zip) { Write-Host 'Nenhum arquivo nexochat*.zip encontrado em Downloads.'; exit 1 }
Write-Host "Usando: $($zip.FullName)  ($($zip.LastWriteTime))"

# Se o NexoChat estava usando o .env.exemplo (ou .env.txt) como configuracao, guarda como .env antes
$envReal = Join-Path $destino '.env'
if (-not (Test-Path $envReal)) {
  foreach ($n in '.env.txt','env','env.txt','.env.exemplo.txt','.env.exemplo') {
    $f = Join-Path $destino $n
    if (Test-Path $f) { Copy-Item $f $envReal; Write-Host "  configuracao guardada: $n -> .env"; break }
  }
}

# Fecha o NexoChat aberto para poder trocar os arquivos
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'server\.js' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }

$temp = Join-Path $env:TEMP ('nexochat-' + [guid]::NewGuid())
Expand-Archive -Path $zip.FullName -DestinationPath $temp -Force
$origem = Get-ChildItem -Path $temp -Filter 'server.js' -File -Recurse | Select-Object -First 1
if (-not $origem) { Write-Host 'O zip nao parece ser do NexoChat (server.js nao encontrado).'; exit 1 }
$origem = $origem.DirectoryName

$manter = @('.env', 'dados', 'node_modules')
Get-ChildItem -Path $origem -Force | Where-Object { $manter -notcontains $_.Name } | ForEach-Object {
  Copy-Item -Path $_.FullName -Destination $destino -Recurse -Force
  Write-Host "  atualizado: $($_.Name)"
}
Remove-Item $temp -Recurse -Force
Write-Host ''
Write-Host 'Pronto! Seu .env e a pasta dados foram mantidos.'
Write-Host 'Agora abra o iniciar.bat.'
