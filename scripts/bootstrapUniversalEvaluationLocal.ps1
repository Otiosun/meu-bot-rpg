Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TargetBranch = 'clover/evaluation-support-migration-2026-10-13'
$Pm2Name = 'clover-rpg'
$ApplyToken = 'APPLY_UNIVERSAL_EVALUATION_LOCAL'

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Falha: $Command $($Arguments -join ' ') (exit=$LASTEXITCODE)"
    }
}

function Get-GitValue {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $value = (& git @Arguments 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') falhou: $value"
    }
    return $value
}

function Set-FeatureOff {
    $env:CLOVER_UNIVERSAL_EVALUATION = '0'
    $env:CLOVER_STRICT_COMMAND_OWNERSHIP = '0'
}

function Stop-CloverPm2 {
    & pm2 stop $Pm2Name | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Não consegui parar o PM2 $Pm2Name."
    }
}

function Restart-CloverPm2Off {
    Set-FeatureOff
    & pm2 restart $Pm2Name --update-env | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Não consegui reiniciar o PM2 $Pm2Name."
    }
}

$Repo = Get-GitValue -Arguments @('rev-parse', '--show-toplevel')
Set-Location $Repo

$Dirty = Get-GitValue -Arguments @('status', '--porcelain')
if ($Dirty) {
    throw "Árvore Git possui alterações locais. Commit/stash antes do bootstrap.`n$Dirty"
}

$OldBranch = Get-GitValue -Arguments @('branch', '--show-current')
$OldHead = Get-GitValue -Arguments @('rev-parse', 'HEAD')
$DbPath = Join-Path $Repo 'banco.sqlite'
$AuthPath = Join-Path $Repo 'auth_info'

if (-not (Test-Path -LiteralPath $DbPath -PathType Leaf)) {
    throw "Banco não encontrado: $DbPath"
}
if (-not (Test-Path -LiteralPath $AuthPath -PathType Container)) {
    throw "auth_info não encontrado: $AuthPath"
}

$Pm2Json = (& pm2 jlist 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    throw 'pm2 jlist falhou.'
}
$Pm2Processes = $Pm2Json | ConvertFrom-Json
$Clover = @($Pm2Processes | Where-Object { $_.name -eq $Pm2Name }) | Select-Object -First 1
if (-not $Clover) {
    throw "Processo PM2 $Pm2Name não encontrado."
}
if ($Clover.pm2_env.status -ne 'online') {
    throw "Processo PM2 $Pm2Name precisa estar online antes do bootstrap; atual=$($Clover.pm2_env.status)"
}

$OldLabel = '(detached)'
if ($OldBranch) {
    $OldLabel = $OldBranch
}

Write-Host ''
Write-Host 'CLOVER — BOOTSTRAP LOCAL DA FILA UNIVERSAL' -ForegroundColor Cyan
Write-Host "Repo: $Repo"
Write-Host "Estado anterior: $OldLabel @ $OldHead"
Write-Host 'auth_info: será preservado'
Write-Host ''

$BootstrapBackup = $null
$Switched = $false

try {
    Set-FeatureOff

    Write-Host '[1/6] Buscando branch remota...'
    Invoke-Checked -Command 'git' -Arguments @('fetch', 'origin')
    Invoke-Checked -Command 'git' -Arguments @('rev-parse', '--verify', "origin/$TargetBranch")

    Write-Host '[2/6] Parando PM2 antes de qualquer checkout...'
    Stop-CloverPm2

    Write-Host '[3/6] Criando backup SQLite verificado ANTES do checkout...'
    $Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $BackupDir = Join-Path $Repo "backups\universal-evaluation-bootstrap-$Stamp"
    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
    $BootstrapBackup = Join-Path $BackupDir 'banco.sqlite'

    $BackupJs = @"
const { backupSqliteDatabase } = require('./helpers/clover/sqliteBackupService');
backupSqliteDatabase(process.argv[1], process.argv[2])
  .then((result) => { console.log(JSON.stringify(result)); })
  .catch((error) => { console.error(error && (error.stack || error.message) || error); process.exit(1); });
"@
    & node -e $BackupJs $DbPath $BootstrapBackup | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw 'Backup SQLite pré-checkout falhou.'
    }

    Write-Host '[4/6] Trocando para a branch de migração...'
    & git show-ref --verify --quiet "refs/heads/$TargetBranch"
    if ($LASTEXITCODE -eq 0) {
        Invoke-Checked -Command 'git' -Arguments @('switch', $TargetBranch)
    } else {
        Invoke-Checked -Command 'git' -Arguments @('switch', '--track', '-c', $TargetBranch, "origin/$TargetBranch")
    }
    $Switched = $true
    Invoke-Checked -Command 'git' -Arguments @('pull', '--ff-only', 'origin', $TargetBranch)

    $AfterSwitchDirty = Get-GitValue -Arguments @('status', '--porcelain')
    if ($AfterSwitchDirty) {
        throw "Branch de migração não ficou limpa após checkout.`n$AfterSwitchDirty"
    }

    Write-Host '[5/6] Aplicando migrations 31–34 com feature OFF...'
    Set-FeatureOff
    & node .\scripts\applyUniversalEvaluationLocal.js "--confirm=$ApplyToken" | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw 'applyUniversalEvaluationLocal.js falhou.'
    }

    Write-Host '[6/6] Checkpoint aplicado com fila universal ainda OFF.' -ForegroundColor Green
    Write-Host ''
    Write-Host "Backup pré-checkout: $BootstrapBackup"
    Write-Host 'PM2: online'
    Write-Host 'CLOVER_UNIVERSAL_EVALUATION=0'
    Write-Host 'auth_info: intocado'
    Write-Host ''
    Write-Host 'Próximo passo, depois do smoke test legado:' -ForegroundColor Yellow
    Write-Host 'node .\scripts\toggleUniversalEvaluationLocal.js --enable --confirm=ENABLE_UNIVERSAL_EVALUATION_LOCAL'
}
catch {
    $Failure = $_
    Write-Host ''
    Write-Host 'BOOTSTRAP FALHOU — iniciando rollback automático.' -ForegroundColor Red
    Write-Host $Failure.Exception.Message -ForegroundColor Red

    try { & pm2 stop $Pm2Name | Out-Null } catch {}

    if ($BootstrapBackup -and (Test-Path -LiteralPath $BootstrapBackup -PathType Leaf)) {
        Write-Host 'Restaurando SQLite anterior...'
        Remove-Item -LiteralPath "$DbPath-wal" -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath "$DbPath-shm" -Force -ErrorAction SilentlyContinue
        Copy-Item -LiteralPath $BootstrapBackup -Destination $DbPath -Force
    } else {
        Write-Host 'ATENÇÃO: backup pré-checkout não está disponível para restauração.' -ForegroundColor Red
    }

    if ($Switched) {
        Write-Host 'Restaurando código anterior...'
        if ($OldBranch) {
            Invoke-Checked -Command 'git' -Arguments @('switch', $OldBranch)
            $RestoredHead = Get-GitValue -Arguments @('rev-parse', 'HEAD')
            if ($RestoredHead -ne $OldHead) {
                Write-Host "Branch $OldBranch não voltou ao SHA original; usando detached no SHA salvo." -ForegroundColor Yellow
                Invoke-Checked -Command 'git' -Arguments @('checkout', '--detach', $OldHead)
            }
        } else {
            Invoke-Checked -Command 'git' -Arguments @('checkout', '--detach', $OldHead)
        }
    }

    Write-Host 'Reiniciando runtime anterior com features novas OFF...'
    Restart-CloverPm2Off

    if (Test-Path -LiteralPath '.\scripts\diagnoseCloverRuntime.js' -PathType Leaf) {
        & node .\scripts\diagnoseCloverRuntime.js | Out-Host
    }

    throw $Failure
}
