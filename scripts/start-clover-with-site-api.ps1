$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot

$env:CLOVER_SITE_API_ENABLED = "1"
$env:CLOVER_SITE_API_PORT = "8787"
$env:CLOVER_SITE_API_HOST = "0.0.0.0"

node index.js
