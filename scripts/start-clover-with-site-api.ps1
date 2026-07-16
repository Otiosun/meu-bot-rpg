$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot

Write-Host "[clover-site] Iniciando bot, API local e ngrok no mesmo processo supervisor"
node scripts/startCloverSiteStack.js

if ($LASTEXITCODE -ne 0) {
    throw "A stack do site encerrou com código $LASTEXITCODE."
}
