param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$original = (Get-Location).Path

$runtimeHotfixSyntaxTargets = @(
    'index.js',
    'helpers/clover/adminApiSupportBase.js',
    'helpers/clover/canonicalScopedAccessService.js',
    'helpers/clover/checklistService.js',
    'helpers/clover/communityExitManager.js',
    'helpers/clover/economyService.js',
    'helpers/clover/marketService.js',
    'helpers/clover/playerReset.js',
    'helpers/clover/siteApiServer.js',
    'helpers/clover/skillTreeService.js'
)

$stabilitySyntaxTargets = @(
    'helpers/clover/quickEvaluationService.js',
    'helpers/clover/quickEvaluationStarBackfillService.js',
    'helpers/clover/quickEvaluationWeekRepairService.js',
    'helpers/clover/squadSeasonStarService.js',
    'scripts/backfillQuickEvaluationSeasonStars.js',
    'scripts/preflightPlayerStabilityLiveState.js',
    'scripts/repairQuickEvaluationWeekKeysV3.js',
    'tests/quickEvaluationSquadStarsIntegration.test.js',
    'tests/quickEvaluationStarBackfill.test.js',
    'tests/quickEvaluationWeekRepair.test.js',
    'tests/squadSeasonStarService.test.js'
)

$syntaxTargets = @($runtimeHotfixSyntaxTargets + $stabilitySyntaxTargets)

$testTargets = @(
    'tests/quickEvaluationSquadStarsIntegration.test.js',
    'tests/quickEvaluationStarBackfill.test.js',
    'tests/quickEvaluationWeekRepair.test.js',
    'tests/squadSeasonStarService.test.js'
)

$powerShellTargets = @(
    'scripts/collectPlayerStabilityRuntimeDelta.ps1',
    'scripts/runPlayerStabilityReadOnlyPreflight.ps1',
    'scripts/snapshotLiveTrackedHotfixes.ps1',
    'scripts/runPlayerStabilityIsolatedGate.ps1'
)

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command $($Arguments -join ' ') falhou com exit code $LASTEXITCODE."
    }
}

function Get-GitText([string[]]$Arguments, [switch]$Required) {
    $lines = @(& git @Arguments)
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') falhou com exit code $LASTEXITCODE."
    }
    $values = @($lines | Where-Object { $null -ne $_ -and ([string]$_).Trim() })
    if ($values.Count -eq 0) {
        if ($Required) { throw "git $($Arguments -join ' ') nao retornou valor." }
        return ''
    }
    return ([string]$values[0]).Trim()
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

    foreach ($relative in @($syntaxTargets + $powerShellTargets)) {
        $path = Join-Path $repo $relative
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Arquivo esperado ausente: $relative"
        }
    }

    Set-Location $repo
    $env:NODE_ENV = 'test'

    $head = Get-GitText @('rev-parse', 'HEAD') -Required
    $branchProbe = @(& git symbolic-ref --quiet --short HEAD)
    $branch = if ($LASTEXITCODE -eq 0 -and $branchProbe.Count -gt 0 -and ([string]$branchProbe[0]).Trim()) {
        ([string]$branchProbe[0]).Trim()
    } else {
        '(detached)'
    }
    Write-Host "Candidate branch: $branch" -ForegroundColor DarkGray
    Write-Host "Candidate HEAD:   $head" -ForegroundColor DarkGray
    Write-Host "Runtime hotfix files preserved in gate: $($runtimeHotfixSyntaxTargets.Count)" -ForegroundColor DarkGray

    Write-Host '1/4 node --check (stability + preserved runtime hotfixes)' -ForegroundColor Cyan
    foreach ($relative in $syntaxTargets) {
        Invoke-Checked 'node' @('--check', $relative)
    }

    Write-Host '2/4 PowerShell parse' -ForegroundColor Cyan
    foreach ($relative in $powerShellTargets) {
        $tokens = $null
        $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile(
            (Join-Path $repo $relative),
            [ref]$tokens,
            [ref]$errors
        )
        if ($errors.Count -gt 0) {
            throw "PowerShell invalido em $relative`: $($errors[0].Message)"
        }
    }

    Write-Host '3/4 targeted node:test suites (SQLite :memory: only)' -ForegroundColor Cyan
    Invoke-Checked 'node' (@('--test') + $testTargets)

    Write-Host '4/4 git diff --check' -ForegroundColor Cyan
    Invoke-Checked 'git' @('diff', '--check', 'main...HEAD')

    Write-Host 'PLAYER_STABILITY_GATE=PASS' -ForegroundColor Green
    Write-Host 'Nenhum banco de arquivo, PM2, sessao, Mudzap ou Raid foi tocado por este gate.' -ForegroundColor DarkGray
}
finally {
    Set-Location $original
}
