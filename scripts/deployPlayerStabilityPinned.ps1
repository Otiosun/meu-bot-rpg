param(
    [string]$RepoRoot = 'C:\Users\natan\Documents\meu-bot-rpg',
    [string]$BackupRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$CandidateCommit = '942544803c8b38927a71d69d29873348b7329d41'
$SnapshotCommit = '3a86e45019666bbfa94cfe53656bdc18314c3f35'
$ExpectedLiveHead = '923d05b66883e39510c68e14a109b005950d6cfc'
$SnapshotBranch = 'runtime-hotfix-snapshot-20260808-923d05b'
$ReleaseBranch = 'release/player-stability-20260808'

$HotfixPaths = @(
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

$RuntimeTargets = @(
    'helpers/clover/siteAuthService.js',
    'helpers/clover/siteIdentityGraph.js',
    'helpers/groupAccess.js',
    'helpers/clover/quickEvaluationService.js',
    'helpers/clover/quickEvaluationStarBackfillService.js',
    'helpers/clover/quickEvaluationWeekRepairService.js',
    'helpers/clover/squadSeasonStarService.js'
)

$ExpectedAbsentBeforeDeploy = @(
    'helpers/clover/siteIdentityGraph.js',
    'helpers/clover/quickEvaluationStarBackfillService.js',
    'helpers/clover/quickEvaluationWeekRepairService.js'
)

function Invoke-Git([string[]]$Arguments, [switch]$AllowFailure) {
    $stderrFile = [System.IO.Path]::GetTempFileName()
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $stdout = @(& git @Arguments 2> $stderrFile)
        $code = $LASTEXITCODE
        $stderr = if (Test-Path -LiteralPath $stderrFile) { @(Get-Content -LiteralPath $stderrFile -ErrorAction SilentlyContinue) } else { @() }
    }
    finally {
        $ErrorActionPreference = $previous
        Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    }
    if ($code -ne 0 -and -not $AllowFailure) {
        $detail = if ($stderr.Count) { $stderr -join [Environment]::NewLine } else { $stdout -join [Environment]::NewLine }
        throw "git $($Arguments -join ' ') falhou (exit $code): $detail"
    }
    return [pscustomobject]@{ ExitCode = $code; Stdout = @($stdout); Stderr = @($stderr) }
}

function First-Line($Result, [switch]$Required) {
    $values = @($Result.Stdout | Where-Object { $null -ne $_ -and ([string]$_).Trim() })
    if ($values.Count -eq 0) {
        if ($Required) { throw 'Comando esperado nao retornou stdout.' }
        return ''
    }
    return ([string]$values[0]).Trim()
}

function Git-BlobAt([string]$Ref, [string]$RelativePath) {
    $result = Invoke-Git @('rev-parse', "$Ref`:$RelativePath") -AllowFailure
    if ($result.ExitCode -ne 0) { return $null }
    $line = First-Line $result
    if ($line) { return $line }
    return $null
}

function Worktree-Blob([string]$RelativePath) {
    $full = Join-Path $script:Repo $RelativePath
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { return $null }
    return First-Line (Invoke-Git @('hash-object', '--', $RelativePath)) -Required
}

function Get-Pm2State([string]$Name) {
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $raw = @(& pm2 jlist 2>$null)
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) { throw 'pm2 jlist falhou.' }
    $json = ($raw -join [Environment]::NewLine).Trim()
    if (-not $json) { return $null }
    $rows = @($json | ConvertFrom-Json)
    $row = $rows | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if (-not $row) { return $null }
    $pidValue = 0
    if ($null -ne $row.pid) { $pidValue = [int]$row.pid }
    $statusValue = ''
    if ($null -ne $row.pm2_env -and $null -ne $row.pm2_env.status) { $statusValue = [string]$row.pm2_env.status }
    return [pscustomobject]@{
        name = $Name
        pid = $pidValue
        status = $statusValue
    }
}

function Wait-Health([int]$TimeoutSeconds = 45) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 2
            if ([int]$response.StatusCode -eq 200) { return $true }
        } catch {}
        Start-Sleep -Milliseconds 700
    }
    return $false
}

function Restart-Clover {
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & pm2 restart clover-rpg
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) { throw 'pm2 restart clover-rpg falhou.' }
}

function Backup-LiveDatabase([string]$Source, [string]$Destination) {
    $helper = Join-Path $script:Repo 'helpers\clover\sqliteBackupService.js'
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'sqliteBackupService.js ausente no runtime.' }

    $tempJs = Join-Path ([System.IO.Path]::GetTempPath()) ("clover-player-stability-backup-" + [guid]::NewGuid().ToString('N') + '.js')
    $oldNodePath = $env:NODE_PATH
    try {
        $scriptText = @'
'use strict';
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const helperPath = process.argv[2];
const sourcePath = process.argv[3];
const destinationPath = process.argv[4];
const { backupSqliteDatabase } = require(helperPath);
async function inspect(file) {
  const db = await open({ filename: file, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
  try {
    await db.exec('PRAGMA query_only = ON');
    const quick = await db.get('PRAGMA quick_check');
    const fk = await db.all('PRAGMA foreign_key_check');
    return { quickCheck: quick ? Object.values(quick)[0] : null, foreignKeyViolations: fk.length };
  } finally { await db.close(); }
}
(async () => {
  const before = await inspect(sourcePath);
  if (before.quickCheck !== 'ok' || before.foreignKeyViolations !== 0) {
    throw new Error(`Fonte recusada: quick_check=${before.quickCheck}; fk=${before.foreignKeyViolations}`);
  }
  const backup = await backupSqliteDatabase(sourcePath, destinationPath);
  const after = await inspect(destinationPath);
  if (after.quickCheck !== 'ok' || after.foreignKeyViolations !== 0) {
    throw new Error(`Backup recusado: quick_check=${after.quickCheck}; fk=${after.foreignKeyViolations}`);
  }
  console.log(JSON.stringify({ backup, sourceIntegrity: before, backupIntegrity: after }));
})().catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); });
'@
        [System.IO.File]::WriteAllText($tempJs, $scriptText, (New-Object System.Text.UTF8Encoding($false)))
        $env:NODE_PATH = Join-Path $script:Repo 'node_modules'
        $previous = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $output = @(& node $tempJs $helper $Source $Destination 2>&1)
            $code = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previous
        }
        if ($code -ne 0) { throw "Backup SQLite falhou: $($output -join [Environment]::NewLine)" }
        $jsonLine = @($output | Where-Object { ([string]$_).Trim().StartsWith('{') }) | Select-Object -Last 1
        if (-not $jsonLine) { throw 'Backup SQLite nao retornou JSON de verificacao.' }
        return ([string]$jsonLine | ConvertFrom-Json)
    }
    finally {
        if ($null -eq $oldNodePath) { Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue } else { $env:NODE_PATH = $oldNodePath }
        Remove-Item -LiteralPath $tempJs -Force -ErrorAction SilentlyContinue
    }
}

function Restore-CodeFiles {
    foreach ($state in $script:FileStates) {
        $target = Join-Path $script:Repo $state.path
        if ($state.existedBefore) {
            $backup = Join-Path $script:CodeBackupRoot $state.path
            $parent = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            Copy-Item -LiteralPath $backup -Destination $target -Force
        } else {
            Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
        }
    }
}

$script:Repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$original = (Get-Location).Path
$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
if (-not $BackupRoot) {
    $BackupRoot = Join-Path (Split-Path -Parent $script:Repo) 'clover-rpg-release-backups'
}
$backupDir = Join-Path ([System.IO.Path]::GetFullPath($BackupRoot)) "player-stability-$timestamp"
$script:CodeBackupRoot = Join-Path $backupDir 'code-before'
$dbBackupPath = Join-Path $backupDir 'banco.sqlite'
$tempWorktree = Join-Path ([System.IO.Path]::GetTempPath()) ("clover-player-stability-deploy-" + [guid]::NewGuid().ToString('N'))
$script:FileStates = @()
$worktreeCreated = $false
$filesChanged = $false
$deploymentHealthy = $false
$mudzapBefore = $null
$mudzapAfter = $null
$cloverBefore = $null
$cloverAfter = $null
$backupResult = $null

try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git nao encontrado no PATH.' }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node nao encontrado no PATH.' }
    if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) { throw 'pm2 nao encontrado no PATH.' }
    if (-not (Test-Path -LiteralPath (Join-Path $script:Repo '.git'))) { throw 'RepoRoot nao e checkout Git.' }
    Set-Location $script:Repo

    Write-Host '1/8 Validando runtime vivo e refs pinadas...' -ForegroundColor Cyan
    Invoke-Git @('fetch', 'origin', $ReleaseBranch, $SnapshotBranch) | Out-Null
    $head = First-Line (Invoke-Git @('rev-parse', 'HEAD')) -Required
    if ($head -ne $ExpectedLiveHead) { throw "HEAD vivo mudou: esperado $ExpectedLiveHead, atual $head." }
    foreach ($commit in @($CandidateCommit, $SnapshotCommit)) {
        $probe = Invoke-Git @('cat-file', '-e', "$commit`^{commit}") -AllowFailure
        if ($probe.ExitCode -ne 0) { throw "Commit pinado indisponivel localmente: $commit" }
    }

    foreach ($path in $HotfixPaths) {
        $liveBlob = Worktree-Blob $path
        $snapshotBlob = Git-BlobAt $SnapshotCommit $path
        if (-not $liveBlob -or -not $snapshotBlob -or $liveBlob -ne $snapshotBlob) {
            throw "Hotfix vivo mudou desde o snapshot: $path"
        }
    }

    foreach ($path in $RuntimeTargets) {
        $full = Join-Path $script:Repo $path
        if ($ExpectedAbsentBeforeDeploy -contains $path) {
            if (Test-Path -LiteralPath $full) { throw "Arquivo que deveria estar ausente apareceu antes do deploy: $path" }
            continue
        }
        $liveBlob = Worktree-Blob $path
        $baseBlob = Git-BlobAt $ExpectedLiveHead $path
        if (-not $liveBlob -or -not $baseBlob -or $liveBlob -ne $baseBlob) {
            throw "Arquivo alvo foi alterado desde o preflight: $path"
        }
    }

    $cloverBefore = Get-Pm2State 'clover-rpg'
    $mudzapBefore = Get-Pm2State 'mudzap'
    if (-not $cloverBefore -or $cloverBefore.status -ne 'online') { throw 'clover-rpg nao esta online antes do deploy.' }

    Write-Host '2/8 Criando backup SQLite consistente e verificando integridade...' -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $script:CodeBackupRoot -Force | Out-Null
    $sourceDb = Join-Path $script:Repo 'banco.sqlite'
    $backupResult = Backup-LiveDatabase $sourceDb $dbBackupPath
    Write-Host "Backup SQLite: $dbBackupPath" -ForegroundColor Green

    Write-Host '3/8 Criando worktree temporario do commit que passou 21/21...' -ForegroundColor Cyan
    Invoke-Git @('worktree', 'add', '--detach', $tempWorktree, $CandidateCommit) | Out-Null
    $worktreeCreated = $true

    Write-Host '4/8 Salvando versoes anteriores dos 7 arquivos alvo...' -ForegroundColor Cyan
    foreach ($path in $RuntimeTargets) {
        $target = Join-Path $script:Repo $path
        $existed = Test-Path -LiteralPath $target -PathType Leaf
        $script:FileStates += [pscustomobject]@{ path = $path; existedBefore = $existed }
        if ($existed) {
            $backupPath = Join-Path $script:CodeBackupRoot $path
            $parent = Split-Path -Parent $backupPath
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
            Copy-Item -LiteralPath $target -Destination $backupPath -Force
        }
    }

    Write-Host '5/8 Aplicando somente os 7 arquivos runtime pinados...' -ForegroundColor Cyan
    foreach ($path in $RuntimeTargets) {
        $source = Join-Path $tempWorktree $path
        $target = Join-Path $script:Repo $path
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Candidata sem arquivo esperado: $path" }
        $parent = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        Copy-Item -LiteralPath $source -Destination $target -Force
        $filesChanged = $true
        $liveBlob = Worktree-Blob $path
        $candidateBlob = Git-BlobAt $CandidateCommit $path
        if (-not $candidateBlob -or $liveBlob -ne $candidateBlob) { throw "Hash pos-copia divergiu da candidata: $path" }
        $previous = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & node --check $target
            $nodeCheckCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previous
        }
        if ($nodeCheckCode -ne 0) { throw "node --check falhou apos copia: $path" }
    }

    Write-Host '6/8 Reiniciando SOMENTE clover-rpg...' -ForegroundColor Cyan
    Restart-Clover

    Write-Host '7/8 Aguardando health local e estado PM2...' -ForegroundColor Cyan
    if (-not (Wait-Health 45)) { throw 'Health local nao voltou em ate 45s.' }
    $cloverAfter = Get-Pm2State 'clover-rpg'
    if (-not $cloverAfter -or $cloverAfter.status -ne 'online') { throw 'clover-rpg nao ficou online apos restart.' }
    $deploymentHealthy = $true

    Write-Host '8/8 Confirmando que Mudzap nao foi tocado...' -ForegroundColor Cyan
    $mudzapAfter = Get-Pm2State 'mudzap'
    if ($mudzapBefore) {
        if (-not $mudzapAfter) { throw 'Mudzap desapareceu do PM2 durante o deploy.' }
        if ($mudzapBefore.pid -ne $mudzapAfter.pid -or $mudzapBefore.status -ne $mudzapAfter.status) {
            throw "Estado do Mudzap mudou inesperadamente: antes pid=$($mudzapBefore.pid) status=$($mudzapBefore.status); depois pid=$($mudzapAfter.pid) status=$($mudzapAfter.status)."
        }
    }

    $manifest = [ordered]@{
        deployedAt = (Get-Date).ToUniversalTime().ToString('o')
        candidateCommit = $CandidateCommit
        snapshotCommit = $SnapshotCommit
        liveBaseHead = $ExpectedLiveHead
        databaseBackup = $dbBackupPath
        databaseBackupMethod = $backupResult.backup.method
        databaseBackupBytes = $backupResult.backup.bytes
        databaseQuickCheck = $backupResult.backupIntegrity.quickCheck
        databaseForeignKeyViolations = $backupResult.backupIntegrity.foreignKeyViolations
        runtimeTargets = $RuntimeTargets
        preservedHotfixes = $HotfixPaths
        cloverBefore = $cloverBefore
        cloverAfter = $cloverAfter
        mudzapBefore = $mudzapBefore
        mudzapAfter = $mudzapAfter
    }
    $manifestPath = Join-Path $backupDir 'deploy-manifest-sanitized.json'
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

    Write-Host 'PLAYER_STABILITY_DEPLOY=PASS' -ForegroundColor Green
    Write-Host "CANDIDATE_HEAD=$CandidateCommit"
    Write-Host "BACKUP_DIR=$backupDir"
    Write-Host "DB_BACKUP=$dbBackupPath"
    Write-Host "MANIFEST=$manifestPath"
    Write-Host 'CODE_FILES_APPLIED=7'
    Write-Host 'WEEK_REPAIR_APPLIED=0'
    Write-Host 'STAR_BACKFILL_APPLIED=0'
    Write-Host 'MUDZAP_TOUCHED=0'
    Write-Host 'RAID_TOUCHED=0'
}
catch {
    $errorMessage = $_.Exception.Message
    Write-Host "DEPLOY_ERROR=$errorMessage" -ForegroundColor Red
    if ($filesChanged -and -not $deploymentHealthy) {
        Write-Host 'Falha antes de health confirmado: restaurando os 7 arquivos anteriores...' -ForegroundColor Yellow
        try {
            Restore-CodeFiles
            Restart-Clover
            $rollbackHealthy = Wait-Health 45
            Write-Host "ROLLBACK_HEALTH=$rollbackHealthy"
        } catch {
            Write-Host "ROLLBACK_ERROR=$($_.Exception.Message)" -ForegroundColor Red
        }
    } elseif ($filesChanged -and $deploymentHealthy) {
        Write-Host 'Codigo novo esta healthy; nenhum rollback automatico foi feito para evento externo posterior.' -ForegroundColor Yellow
    }
    throw
}
finally {
    if ($worktreeCreated) {
        Set-Location $script:Repo
        Invoke-Git @('worktree', 'remove', '--force', $tempWorktree) -AllowFailure | Out-Null
    }
    Set-Location $original
}
