param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,
    [string]$OutputDir = [Environment]::GetFolderPath('Desktop')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$releaseRef = 'origin/release/player-stability-20260808'
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) 'clover-player-stability-preflight'
$collector = Join-Path $tempDir 'collectPlayerStabilityRuntimeDelta.ps1'
$statePreflight = Join-Path $tempDir 'preflightPlayerStabilityLiveState.js'
$deltaOut = Join-Path $OutputDir 'player-stability-runtime-delta-sanitized.json'
$stateOut = Join-Path $OutputDir 'player-stability-live-preflight-sanitized.json'
$dbPath = Join-Path $repo 'banco.sqlite'

function Invoke-Checked([scriptblock]$Command, [string]$Label) {
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label falhou com exit code $LASTEXITCODE."
    }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git nao foi encontrado no PATH.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node nao foi encontrado no PATH.' }
if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) { throw 'RepoRoot nao e um checkout Git.' }
if (-not (Test-Path -LiteralPath $dbPath -PathType Leaf)) { throw 'banco.sqlite nao encontrado no RepoRoot informado.' }
if (-not (Test-Path -LiteralPath $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null }
if (-not (Test-Path -LiteralPath $tempDir)) { New-Item -ItemType Directory -Path $tempDir -Force | Out-Null }

$original = (Get-Location).Path
try {
    Set-Location $repo

    Write-Host '1/4 Atualizando somente refs remotas (sem checkout/reset)...' -ForegroundColor Cyan
    & git fetch --prune origin `
        '+refs/heads/main:refs/remotes/origin/main' `
        '+refs/heads/release/player-stability-20260808:refs/remotes/origin/release/player-stability-20260808'
    if ($LASTEXITCODE -ne 0) { throw 'git fetch das refs falhou.' }

    $refProbe = & git rev-parse --verify --quiet $releaseRef
    if ($LASTEXITCODE -ne 0 -or -not $refProbe) { throw "Ref candidata ausente: $releaseRef" }

    Write-Host '2/4 Extraindo ferramentas da candidata para TEMP (sem mudar worktree)...' -ForegroundColor Cyan
    & git show "$releaseRef`:scripts/collectPlayerStabilityRuntimeDelta.ps1" | Set-Content -LiteralPath $collector -Encoding UTF8
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao extrair coletor sanitizado.' }
    & git show "$releaseRef`:scripts/preflightPlayerStabilityLiveState.js" | Set-Content -LiteralPath $statePreflight -Encoding UTF8
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao extrair preflight de estado.' }

    Write-Host '3/4 Coletando delta de codigo sanitizado...' -ForegroundColor Cyan
    & powershell -NoProfile -ExecutionPolicy Bypass -File $collector -RepoRoot $repo -OutputPath $deltaOut
    if ($LASTEXITCODE -ne 0) { throw 'Coletor de runtime delta falhou.' }

    Write-Host '4/4 Lendo somente agregados do SQLite em modo READONLY/query_only...' -ForegroundColor Cyan
    & node $statePreflight "--repo=$repo" "--db=$dbPath" "--output=$stateOut"
    if ($LASTEXITCODE -ne 0) { throw 'Preflight read-only do SQLite falhou.' }

    Write-Host ''
    Write-Host 'PLAYER_STABILITY_READONLY_PREFLIGHT=PASS' -ForegroundColor Green
    Write-Host 'Nenhum checkout/reset, PM2, Mudzap, Raid ou escrita no SQLite foi executado.' -ForegroundColor DarkGray
    Write-Host 'Envie estes dois arquivos:' -ForegroundColor Yellow
    Write-Host "  $deltaOut"
    Write-Host "  $stateOut"
}
finally {
    Set-Location $original
}
