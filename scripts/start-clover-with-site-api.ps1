$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot

if (-not $env:CLOVER_SITE_API_ENABLED) { $env:CLOVER_SITE_API_ENABLED = "1" }
if (-not $env:CLOVER_SITE_API_PORT) { $env:CLOVER_SITE_API_PORT = "8787" }
if (-not $env:CLOVER_SITE_API_HOST) { $env:CLOVER_SITE_API_HOST = "0.0.0.0" }

Write-Host "[clover-site-api] Iniciando bot com API em $($env:CLOVER_SITE_API_HOST):$($env:CLOVER_SITE_API_PORT)"
node index.js

if ($LASTEXITCODE -ne 0) {
    throw "O processo do bot encerrou com código $LASTEXITCODE."
}
