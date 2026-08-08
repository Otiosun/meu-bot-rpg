param(
    [string]$RepoRoot = 'C:\Users\natan\Documents\meu-bot-rpg'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$releaseRef = 'origin/release/player-stability-20260808'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("clover-player-stability-gate-" + [guid]::NewGuid().ToString('N'))
$worktreeAdded = $false
$original = (Get-Location).Path

function Invoke-Checked([string]$Command, [string[]]$Arguments, [string]$WorkingDirectory = $repo) {
    Push-Location $WorkingDirectory
    try {
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$Command $($Arguments -join ' ') falhou com exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

try {
    foreach ($command in @('git', 'node', 'npm', 'powershell')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw "$command nao foi encontrado no PATH."
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) {
        throw 'RepoRoot nao e o checkout Git esperado.'
    }

    Write-Host '1/5 Atualizando refs da candidata e main (sem checkout/reset do runtime)...' -ForegroundColor Cyan
    Invoke-Checked 'git' @(
        'fetch', '--prune', 'origin',
        '+refs/heads/main:refs/remotes/origin/main',
        '+refs/heads/release/player-stability-20260808:refs/remotes/origin/release/player-stability-20260808'
    )

    $candidateHead = (& git -C $repo rev-parse $releaseRef).Trim()
    if (-not $candidateHead) { throw 'Nao foi possivel resolver o HEAD da candidata.' }

    Write-Host '2/5 Criando worktree temporario destacado...' -ForegroundColor Cyan
    Invoke-Checked 'git' @('worktree', 'add', '--detach', $tempRoot, $releaseRef)
    $worktreeAdded = $true

    $dangerousDb = Get-ChildItem -LiteralPath $tempRoot -File -Recurse -Filter 'banco.sqlite' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($dangerousDb) {
        throw "Gate recusado: banco.sqlite apareceu no checkout temporario ($($dangerousDb.FullName))."
    }

    Write-Host '3/5 Instalando dependencias somente no worktree temporario...' -ForegroundColor Cyan
    $env:NODE_ENV = 'test'
    $env:npm_config_audit = 'false'
    $env:npm_config_fund = 'false'
    Invoke-Checked 'npm' @('ci', '--no-audit', '--no-fund') $tempRoot

    Write-Host '4/5 Executando gate da release...' -ForegroundColor Cyan
    $gate = Join-Path $tempRoot 'scripts\verifyPlayerStabilityRelease.ps1'
    if (-not (Test-Path -LiteralPath $gate -PathType Leaf)) {
        throw 'verifyPlayerStabilityRelease.ps1 ausente no checkout temporario.'
    }
    Invoke-Checked 'powershell' @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', $gate,
        '-RepoRoot', $tempRoot
    ) $tempRoot

    $actualHead = (& git -C $tempRoot rev-parse HEAD).Trim()
    if ($actualHead -ne $candidateHead) {
        throw "HEAD do gate divergiu da candidata. Esperado $candidateHead, atual $actualHead."
    }

    Write-Host '5/5 Gate isolado concluido.' -ForegroundColor Cyan
    Write-Host 'ISOLATED_PLAYER_STABILITY_GATE=PASS' -ForegroundColor Green
    Write-Host "CANDIDATE_HEAD=$candidateHead"
    Write-Host 'Nenhum banco vivo, PM2, Mudzap, Raid, checkout ou indice do runtime foi alterado.' -ForegroundColor DarkGray
}
finally {
    Set-Location $original
    if ($worktreeAdded -and (Test-Path -LiteralPath $tempRoot)) {
        try {
            & git -C $repo worktree remove --force $tempRoot | Out-Null
        } catch {
            Write-Warning "Nao consegui remover automaticamente o worktree temporario: $tempRoot"
        }
    } elseif (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
