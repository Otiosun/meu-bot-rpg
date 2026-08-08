param(
    [string]$RepoRoot = 'C:\Users\natan\Documents\meu-bot-rpg',
    [string]$BackupRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$CandidateCommit = '942544803c8b38927a71d69d29873348b7329d41'
$SnapshotCommit = '3a86e45019666bbfa94cfe53656bdc18314c3f35'
$ExpectedLiveHead = '923d05b66883e39510c68e14a109b005950d6cfc'
$ReleaseBranch = 'release/player-stability-20260808'
$SnapshotBranch = 'runtime-hotfix-snapshot-20260808-923d05b'

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
    $old = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $stdout = @(& git @Arguments 2> $stderrFile)
        $code = $LASTEXITCODE
        $stderr = if (Test-Path -LiteralPath $stderrFile) { @(Get-Content -LiteralPath $stderrFile -ErrorAction SilentlyContinue) } else { @() }
    }
    finally {
        $ErrorActionPreference = $old
        Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    }
    if ($code -ne 0 -and -not $AllowFailure) {
        $detail = if ($stderr.Count) { $stderr -join [Environment]::NewLine } else { $stdout -join [Environment]::NewLine }
        throw "git $($Arguments -join ' ') falhou (exit $code): $detail"
    }
    [pscustomobject]@{ ExitCode = $code; Stdout = @($stdout); Stderr = @($stderr) }
}

function Invoke-NodeCapture([string[]]$Arguments) {
    $stderrFile = [System.IO.Path]::GetTempFileName()
    $old = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $stdout = @(& node @Arguments 2> $stderrFile)
        $code = $LASTEXITCODE
        $stderr = if (Test-Path -LiteralPath $stderrFile) { @(Get-Content -LiteralPath $stderrFile -ErrorAction SilentlyContinue) } else { @() }
    }
    finally {
        $ErrorActionPreference = $old
        Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    }
    [pscustomobject]@{ ExitCode = $code; Stdout = @($stdout); Stderr = @($stderr) }
}

function First-Line($Result, [switch]$Required) {
    $values = @($Result.Stdout | Where-Object { $null -ne $_ -and ([string]$_).Trim() })
    if ($values.Count -eq 0) {
        if ($Required) { throw 'Comando esperado nao retornou stdout.' }
        return ''
    }
    ([string]$values[0]).Trim()
}

function Git-BlobAt([string]$Ref, [string]$RelativePath) {
    $r = Invoke-Git @('rev-parse', "$Ref`:$RelativePath") -AllowFailure
    if ($r.ExitCode -ne 0) { return $null }
    $line = First-Line $r
    if ($line) { return $line }
    $null
}

function Worktree-Blob([string]$RelativePath) {
    $full = Join-Path $script:Repo $RelativePath
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { return $null }
    First-Line (Invoke-Git @('hash-object', '--', $RelativePath)) -Required
}

function Get-Pm2Pid([string]$Name) {
    $stderrFile = [System.IO.Path]::GetTempFileName()
    $old = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $stdout = @(& pm2 pid $Name 2> $stderrFile)
        $code = $LASTEXITCODE
        $stderr = if (Test-Path -LiteralPath $stderrFile) { @(Get-Content -LiteralPath $stderrFile -ErrorAction SilentlyContinue) } else { @() }
    }
    finally {
        $ErrorActionPreference = $old
        Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    }
    if ($code -ne 0) {
        throw "pm2 pid $Name falhou (exit $code): $($stderr -join [Environment]::NewLine)"
    }
    $numeric = @($stdout | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ -match '^\d+$' })
    if ($numeric.Count -eq 0) { return 0 }
    [int]$numeric[$numeric.Count - 1]
}

function Restart-Clover {
    $stderrFile = [System.IO.Path]::GetTempFileName()
    $old = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $stdout = @(& pm2 restart clover-rpg 2> $stderrFile)
        $code = $LASTEXITCODE
        $stderr = if (Test-Path -LiteralPath $stderrFile) { @(Get-Content -LiteralPath $stderrFile -ErrorAction SilentlyContinue) } else { @() }
    }
    finally {
        $ErrorActionPreference = $old
        Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    }
    if ($code -ne 0) { throw "pm2 restart clover-rpg falhou (exit $code): $($stderr -join [Environment]::NewLine)" }
    $stdout | Write-Host
}

function Wait-Health([int]$TimeoutSeconds = 45) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 2
            if ([int]$r.StatusCode -eq 200) { return $true }
        } catch {}
        Start-Sleep -Milliseconds 700
    }
    $false
}

function Inspect-Sqlite([string]$DbPath) {
    $js = Join-Path ([System.IO.Path]::GetTempPath()) ("clover-sqlite-inspect-" + [guid]::NewGuid().ToString('N') + '.js')
    $oldNodePath = $env:NODE_PATH
    try {
        $text = @'
'use strict';
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
(async () => {
 const db = await open({filename: process.argv[2], driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY});
 try {
  await db.exec('PRAGMA query_only=ON');
  const q = await db.get('PRAGMA quick_check');
  const fk = await db.all('PRAGMA foreign_key_check');
  console.log(String(q ? Object.values(q)[0] : '') + '\t' + String(fk.length));
 } finally { await db.close(); }
})().catch(e => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
'@
        [System.IO.File]::WriteAllText($js, $text, (New-Object System.Text.UTF8Encoding($false)))
        $env:NODE_PATH = Join-Path $script:Repo 'node_modules'
        $result = Invoke-NodeCapture @($js, $DbPath)
        if ($result.ExitCode -ne 0) { throw "Inspecao SQLite falhou: $($result.Stderr -join [Environment]::NewLine)" }
        $line = (@($result.Stdout | Where-Object { ([string]$_).Trim() }) -join '').Trim()
        $parts = $line -split "`t", 2
        if ($parts.Count -ne 2) { throw "Saida SQLite inesperada: $line" }
        [pscustomobject]@{ quickCheck = $parts[0]; foreignKeyViolations = [int]$parts[1] }
    }
    finally {
        if ($null -eq $oldNodePath) { Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue } else { $env:NODE_PATH = $oldNodePath }
        Remove-Item -LiteralPath $js -Force -ErrorAction SilentlyContinue
    }
}

function Backup-LiveDatabase([string]$Source,[string]$Destination,[string]$CandidateRoot) {
    $helper = Join-Path $CandidateRoot 'helpers\clover\sqliteBackupService.js'
    $js = Join-Path ([System.IO.Path]::GetTempPath()) ("clover-sqlite-backup-" + [guid]::NewGuid().ToString('N') + '.js')
    $oldNodePath = $env:NODE_PATH
    try {
        $text = @'
'use strict';
const { backupSqliteDatabase } = require(process.argv[2]);
backupSqliteDatabase(process.argv[3], process.argv[4])
 .then(r => console.log(String(r.integrity) + '\t' + String(r.bytes) + '\t' + String(r.method)))
 .catch(e => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
'@
        [System.IO.File]::WriteAllText($js, $text, (New-Object System.Text.UTF8Encoding($false)))
        $env:NODE_PATH = Join-Path $script:Repo 'node_modules'
        $result = Invoke-NodeCapture @($js, $helper, $Source, $Destination)
        if ($result.ExitCode -ne 0) { throw "Backup SQLite falhou: $($result.Stderr -join [Environment]::NewLine)" }
        $line = (@($result.Stdout | Where-Object { ([string]$_).Trim() }) -join '').Trim()
        $parts = $line -split "`t", 3
        if ($parts.Count -ne 3 -or $parts[0] -ne 'ok') { throw "Backup SQLite retornou estado inesperado: $line" }
        [pscustomobject]@{ integrity = $parts[0]; bytes = [int64]$parts[1]; method = $parts[2] }
    }
    finally {
        if ($null -eq $oldNodePath) { Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue } else { $env:NODE_PATH = $oldNodePath }
        Remove-Item -LiteralPath $js -Force -ErrorAction SilentlyContinue
    }
}

function Restore-CodeFiles {
    foreach ($state in $script:FileStates) {
        $target = Join-Path $script:Repo $state.path
        if ($state.existedBefore) {
            $source = Join-Path $script:CodeBackupRoot $state.path
            $parent = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            Copy-Item -LiteralPath $source -Destination $target -Force
        } else {
            Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
        }
    }
}

$script:Repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$original = (Get-Location).Path
$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
if (-not $BackupRoot) { $BackupRoot = Join-Path (Split-Path -Parent $script:Repo) 'clover-rpg-release-backups' }
$backupDir = Join-Path ([System.IO.Path]::GetFullPath($BackupRoot)) "player-stability-$timestamp"
$script:CodeBackupRoot = Join-Path $backupDir 'code-before'
$dbBackup = Join-Path $backupDir 'banco.sqlite'
$tempWorktree = Join-Path ([System.IO.Path]::GetTempPath()) ("clover-player-stability-deploy-" + [guid]::NewGuid().ToString('N'))
$script:FileStates = @()
$worktreeCreated = $false
$filesChanged = $false
$deploymentHealthy = $false

try {
    foreach ($cmd in @('git','node','pm2')) { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd nao encontrado no PATH." } }
    if (-not (Test-Path -LiteralPath (Join-Path $script:Repo '.git'))) { throw 'RepoRoot nao e checkout Git.' }
    Set-Location $script:Repo

    Write-Host '1/9 Validando runtime vivo, refs e PIDs PM2...' -ForegroundColor Cyan
    Invoke-Git @('fetch','origin',$ReleaseBranch,$SnapshotBranch) | Out-Null
    $head = First-Line (Invoke-Git @('rev-parse','HEAD')) -Required
    if ($head -ne $ExpectedLiveHead) { throw "HEAD vivo mudou: $head" }
    foreach ($commit in @($CandidateCommit,$SnapshotCommit)) {
        if ((Invoke-Git @('cat-file','-e',"$commit`^{commit}") -AllowFailure).ExitCode -ne 0) { throw "Commit pinado indisponivel: $commit" }
    }
    foreach ($path in $HotfixPaths) {
        if ((Worktree-Blob $path) -ne (Git-BlobAt $SnapshotCommit $path)) { throw "Hotfix vivo mudou desde snapshot: $path" }
    }
    foreach ($path in $RuntimeTargets) {
        $full = Join-Path $script:Repo $path
        if ($ExpectedAbsentBeforeDeploy -contains $path) {
            if (Test-Path -LiteralPath $full) { throw "Arquivo inesperadamente presente antes do deploy: $path" }
        } else {
            if ((Worktree-Blob $path) -ne (Git-BlobAt $ExpectedLiveHead $path)) { throw "Arquivo alvo mudou desde preflight: $path" }
        }
    }
    $cloverPidBefore = Get-Pm2Pid 'clover-rpg'
    $mudzapPidBefore = Get-Pm2Pid 'mudzap'
    if ($cloverPidBefore -le 0) { throw 'clover-rpg nao tem PID ativo antes do deploy.' }
    if (-not (Wait-Health 10)) { throw 'Health local nao esta respondendo antes do deploy.' }

    Write-Host "CLOVER_PID_BEFORE=$cloverPidBefore" -ForegroundColor DarkGray
    Write-Host "MUDZAP_PID_BEFORE=$mudzapPidBefore" -ForegroundColor DarkGray

    Write-Host '2/9 Criando worktree temporario do commit testado...' -ForegroundColor Cyan
    Invoke-Git @('worktree','add','--detach',$tempWorktree,$CandidateCommit) | Out-Null
    $worktreeCreated = $true

    Write-Host '3/9 Verificando banco vivo antes do backup...' -ForegroundColor Cyan
    $sourceDb = Join-Path $script:Repo 'banco.sqlite'
    $dbBefore = Inspect-Sqlite $sourceDb
    if ($dbBefore.quickCheck -ne 'ok' -or $dbBefore.foreignKeyViolations -ne 0) { throw "Banco vivo recusado: quick=$($dbBefore.quickCheck) fk=$($dbBefore.foreignKeyViolations)" }

    Write-Host '4/9 Criando backup SQLite consistente...' -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $script:CodeBackupRoot -Force | Out-Null
    $backup = Backup-LiveDatabase $sourceDb $dbBackup $tempWorktree
    $dbBackupCheck = Inspect-Sqlite $dbBackup
    if ($dbBackupCheck.quickCheck -ne 'ok' -or $dbBackupCheck.foreignKeyViolations -ne 0) { throw 'Backup SQLite falhou verificacao final.' }
    Write-Host "BACKUP_DB=$dbBackup" -ForegroundColor Green
    Write-Host "BACKUP_BYTES=$($backup.bytes)" -ForegroundColor DarkGray

    Write-Host '5/9 Salvando versoes anteriores dos 7 arquivos alvo...' -ForegroundColor Cyan
    foreach ($path in $RuntimeTargets) {
        $target = Join-Path $script:Repo $path
        $exists = Test-Path -LiteralPath $target -PathType Leaf
        $script:FileStates += [pscustomobject]@{path=$path;existedBefore=$exists}
        if ($exists) {
            $save = Join-Path $script:CodeBackupRoot $path
            New-Item -ItemType Directory -Path (Split-Path -Parent $save) -Force | Out-Null
            Copy-Item -LiteralPath $target -Destination $save -Force
        }
    }

    Write-Host '6/9 Aplicando somente os 7 arquivos runtime pinados...' -ForegroundColor Cyan
    foreach ($path in $RuntimeTargets) {
        $source = Join-Path $tempWorktree $path
        $target = Join-Path $script:Repo $path
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Candidata sem arquivo: $path" }
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Force
        $filesChanged = $true
        if ((Worktree-Blob $path) -ne (Git-BlobAt $CandidateCommit $path)) { throw "Hash pos-copia divergiu: $path" }
        $check = Invoke-NodeCapture @('--check', $target)
        if ($check.ExitCode -ne 0) { throw "node --check falhou em $path`: $($check.Stderr -join [Environment]::NewLine)" }
    }

    Write-Host '7/9 Reiniciando SOMENTE clover-rpg...' -ForegroundColor Cyan
    Restart-Clover

    Write-Host '8/9 Aguardando health e validando PIDs PM2...' -ForegroundColor Cyan
    if (-not (Wait-Health 45)) { throw 'Health local nao voltou em 45s.' }
    $cloverPidAfter = Get-Pm2Pid 'clover-rpg'
    $mudzapPidAfter = Get-Pm2Pid 'mudzap'
    if ($cloverPidAfter -le 0) { throw 'clover-rpg nao tem PID ativo apos restart.' }
    if ($mudzapPidAfter -ne $mudzapPidBefore) { throw "Mudzap mudou de PID durante deploy: antes=$mudzapPidBefore depois=$mudzapPidAfter" }

    Write-Host "CLOVER_PID_AFTER=$cloverPidAfter" -ForegroundColor DarkGray
    Write-Host "MUDZAP_PID_AFTER=$mudzapPidAfter" -ForegroundColor DarkGray

    Write-Host '9/9 Verificando banco vivo depois do restart...' -ForegroundColor Cyan
    $dbAfter = Inspect-Sqlite $sourceDb
    if ($dbAfter.quickCheck -ne 'ok' -or $dbAfter.foreignKeyViolations -ne 0) { throw "Banco pos-deploy invalido: quick=$($dbAfter.quickCheck) fk=$($dbAfter.foreignKeyViolations)" }

    $deploymentHealthy = $true
    Write-Host 'PLAYER_STABILITY_DEPLOY=PASS' -ForegroundColor Green
    Write-Host "CANDIDATE_HEAD=$CandidateCommit"
    Write-Host 'CODE_FILES_APPLIED=7'
    Write-Host 'WEEK_REPAIR_APPLIED=0'
    Write-Host 'STAR_BACKFILL_APPLIED=0'
    Write-Host 'MUDZAP_TOUCHED=0'
    Write-Host 'RAID_TOUCHED=0'
    Write-Host "BACKUP_DIR=$backupDir"
}
catch {
    Write-Host "DEPLOY_ERROR=$($_.Exception.Message)" -ForegroundColor Red
    if ($filesChanged -and -not $deploymentHealthy) {
        Write-Host 'ROLLBACK_CODE=START' -ForegroundColor Yellow
        Restore-CodeFiles
        try { Restart-Clover; [void](Wait-Health 45) } catch {}
        Write-Host 'ROLLBACK_CODE=DONE' -ForegroundColor Yellow
    }
    throw
}
finally {
    if ($worktreeCreated -and (Test-Path -LiteralPath $tempWorktree)) {
        try { Invoke-Git @('worktree','remove','--force',$tempWorktree) | Out-Null } catch { Remove-Item -LiteralPath $tempWorktree -Recurse -Force -ErrorAction SilentlyContinue }
    }
    Set-Location $original
}
