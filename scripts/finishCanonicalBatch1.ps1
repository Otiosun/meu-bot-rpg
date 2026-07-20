$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

node scripts\finishCanonicalBatch1.js
exit $LASTEXITCODE
