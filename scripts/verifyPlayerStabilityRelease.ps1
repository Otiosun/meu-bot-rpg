param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$original = (Get-Location).Path

$syntaxTargets = @(
    'helpers/clover/quickEvaluationService.js',
    'helpers/clover/quickEvaluationWeekRepairService.js',
    'helpers/clover/squadSeasonStarService.js',
    'scripts/repairQuickEvaluationWeekKeysV3.js',
    'tests/quickEvaluationWeekRepair.test.js',
    'tests/squadSeasonStarService.test.js',
    'tests/quickEvaluationSquadStarsIntegration.test.js'
)

$testTargets = @(
    'tests/quickEvaluationWeekRepair.test.js',
    'tests/squadSeasonStarService.test.js',
    'tests/quickEvaluationSquadStarsIntegration.test.js'
)

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command $($Arguments -join ' ') falhou com exit code $LASTEXITCODE."
    }
}

try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw 'git nao foi encontrado no PATH.'
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'node nao foi encontrado no PATH.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) {
        throw 'RepoRoot precisa apontar para um checkout Git separado da producao.'
    }

    $dangerousDb = Get-ChildItem -LiteralPath $repo -File -Recurse -Filter 'banco.sqlite' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($dangerousDb) {
        throw "Gate recusado: banco.sqlite encontrado no checkout candidato ($($dangerousDb.FullName)). Use um checkout limpo/isolado."
    }

    foreach ($relative in $syntaxTargets) {
        $path = Join-Path $repo $relative
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Arquivo esperado ausente: $relative"
        }
    }

    Set-Location $repo
    $env:NODE_ENV = 'test'

    $branch = (& git branch --show-current).Trim()
    $head = (& git rev-parse HEAD).Trim()
    Write-Host "Candidate branch: $branch" -ForegroundColor DarkGray
    Write-Host "Candidate HEAD:   $head" -ForegroundColor DarkGray

    Write-Host '1/3 node --check' -ForegroundColor Cyan
    foreach ($relative in $syntaxTargets) {
        Invoke-Checked 'node' @('--check', $relative)
    }

    Write-Host '2/3 targeted node:test suites (SQLite :memory: only)' -ForegroundColor Cyan
    Invoke-Checked 'node' (@('--test') + $testTargets)

    Write-Host '3/3 git diff --check' -ForegroundColor Cyan
    Invoke-Checked 'git' @('diff', '--check', 'main...HEAD')

    Write-Host 'PLAYER_STABILITY_GATE=PASS' -ForegroundColor Green
    Write-Host 'Nenhum banco de arquivo, PM2, sessao, Mudzap ou Raid foi tocado por este gate.' -ForegroundColor DarkGray
}
finally {
    Set-Location $original
}
