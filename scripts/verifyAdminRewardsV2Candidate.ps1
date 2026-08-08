param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = (Resolve-Path $RepoRoot).Path
$liveDb = Join-Path $repo 'banco.sqlite'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("clover-admin-v2-verify-" + [guid]::NewGuid().ToString('N'))
$mediaRoot = Join-Path $tempRoot 'media'

$syntaxFiles = @(
    'helpers/clover/adminApiSupport.js',
    'helpers/clover/adminBootstrapV2Http.js',
    'helpers/clover/adminBoxCatalogVersionService.js',
    'helpers/clover/adminBoxHttp.js',
    'helpers/clover/adminBoxPityService.js',
    'helpers/clover/adminBoxService.js',
    'helpers/clover/boxCatalogRuntimeService.js',
    'helpers/clover/boxCatalogVersionService.js',
    'helpers/clover/boxPityPolicy.js',
    'helpers/clover/boxPityStateService.js',
    'helpers/clover/boxService.js',
    'helpers/clover/adminCommandCenterHttp.js',
    'helpers/clover/adminCommandCenterServiceV2.js',
    'helpers/clover/adminInventoryInstanceExecutorAdapter.js',
    'helpers/clover/adminInventoryInstanceHttp.js',
    'helpers/clover/adminInventoryInstanceService.js',
    'helpers/clover/adminMediaHttp.js',
    'helpers/clover/adminMediaService.js',
    'helpers/clover/adminOperationContract.js',
    'helpers/clover/adminOperationRegistry.js',
    'helpers/clover/adminOperationService.js',
    'helpers/clover/adminSystemOperationSimulation.js',
    'helpers/clover/adminSystemSpellReviewService.js',
    'helpers/clover/adminPlayerDetailService.js',
    'helpers/clover/adminProgressionService.js',
    'helpers/clover/adminQuickRewardService.js',
    'helpers/clover/adminResourceAdjustmentService.js',
    'helpers/clover/adminRewardServiceV2.js',
    'helpers/clover/adminSpellExecutorAdapter.js',
    'helpers/clover/adminSpellHttp.js',
    'helpers/clover/adminSpellReviewService.js',
    'helpers/clover/adminSpellService.js',
    'helpers/clover/spellReviewExternalJobService.js',
    'helpers/clover/spellReviewFlowOrchestrator.js',
    'helpers/clover/phService.js',
    'helpers/clover/playerStarRewardService.js',
    'helpers/clover/siteApiServer.js',
    'helpers/clover/titleAdminService.js',
    'helpers/clover/weeklyPhCapService.js'
)

$testFiles = @(
    'tests/weeklyPhCapService.test.js',
    'tests/adminRewardServiceV2.test.js',
    'tests/playerStarRewardService.test.js',
    'tests/adminQuickRewardService.test.js',
    'tests/adminMediaService.test.js',
    'tests/adminMediaHttp.test.js',
    'tests/adminOperationRaidTargets.test.js',
    'tests/adminPlayerDetailResources.test.js',
    'tests/adminTitleAndResourceExecutors.test.js',
    'tests/adminRewardCanonicalEffects.test.js',
    'tests/adminInventoryInstanceService.test.js',
    'tests/adminInventoryInstanceHttp.test.js',
    'tests/adminProgressionService.test.js',
    'tests/adminSpellService.test.js',
    'tests/adminSpellReviewService.test.js',
    'tests/adminSystemSpellReviewService.test.js',
    'tests/spellReviewExternalJobService.test.js',
    'tests/adminSpellExternalEffects.test.js',
    'tests/adminBoxService.test.js',
    'tests/adminBoxPityService.test.js',
    'tests/boxCatalogVersionService.test.js',
    'tests/boxCatalogRuntimeService.test.js',
    'tests/boxPersistedRuntimeOpening.test.js',
    'tests/adminBoxCatalogVersionService.test.js'
)

function Require-File([string]$relativePath) {
    $full = Join-Path $repo $relativePath
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "Arquivo obrigatorio ausente: $relativePath" }
    return (Resolve-Path -LiteralPath $full).Path
}
function Invoke-NodeChecked([string[]]$arguments, [string]$label) {
    & node @arguments
    if ($LASTEXITCODE -ne 0) { throw "$label falhou com exit code $LASTEXITCODE." }
}

try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js nao foi encontrado no PATH.' }
    if (-not (Test-Path -LiteralPath (Join-Path $repo 'node_modules'))) { throw 'node_modules nao existe neste checkout. Rode npm install apenas no checkout candidato, nunca como parte deste verificador.' }
    New-Item -ItemType Directory -Force -Path $tempRoot, $mediaRoot | Out-Null
    Set-Location $tempRoot
    $env:NODE_ENV = 'test'
    $env:CLOVER_MEDIA_DIR = $mediaRoot
    $env:CLOVER_TEST_TEMP_DIR = $tempRoot

    Write-Host "[1/3] Guardas de seguranca" -ForegroundColor Cyan
    if ((Get-Location).Path -eq $repo) { throw 'Guard rail falhou: CWD nao pode ser o checkout vivo.' }
    if (Test-Path -LiteralPath (Join-Path (Get-Location).Path 'banco.sqlite')) { throw 'Guard rail falhou: existe banco.sqlite no diretorio temporario antes dos testes.' }
    Write-Host "  Repo: $repo"
    Write-Host "  DB vivo (NAO SERA ABERTO): $liveDb"
    Write-Host "  Temp: $tempRoot"

    Write-Host "[2/3] Syntax check" -ForegroundColor Cyan
    foreach ($relative in $syntaxFiles) {
        $full = Require-File $relative
        Invoke-NodeChecked @('--check', $full) "node --check $relative"
        Write-Host "  OK $relative"
    }

    Write-Host "[3/3] Testes isolados Central ADM V2" -ForegroundColor Cyan
    $absoluteTests = @($testFiles | ForEach-Object { Require-File $_ })
    Invoke-NodeChecked (@('--test') + $absoluteTests) 'node --test Central ADM V2'

    if (Test-Path -LiteralPath $liveDb) {
        $liveInfo = Get-Item -LiteralPath $liveDb
        Write-Host ("DB vivo permaneceu fora da execucao: {0} bytes, last write {1:o}" -f $liveInfo.Length, $liveInfo.LastWriteTimeUtc) -ForegroundColor DarkGray
    }
    Write-Host 'CENTRAL ADM V2: VERIFICADOR ISOLADO APROVADO.' -ForegroundColor Green
}
finally {
    Set-Location $repo
    if (-not $KeepTemp -and (Test-Path -LiteralPath $tempRoot)) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
    elseif ($KeepTemp) { Write-Host "Temp preservado: $tempRoot" -ForegroundColor Yellow }
}
