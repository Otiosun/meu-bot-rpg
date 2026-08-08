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

$CandidatePaths = @(
    'helpers/clover/siteAuthService.js',
    'helpers/clover/siteIdentityGraph.js',
    'helpers/groupAccess.js',
    'helpers/clover/quickEvaluationService.js',
    'helpers/clover/quickEvaluationStarBackfillService.js',
    'helpers/clover/quickEvaluationWeekRepairService.js',
    'helpers/clover/squadSeasonStarService.js'
)

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
    return ([string]$values[0]).Trim()
}

function Git-BlobAt([string]$Ref, [string]$RelativePath) {
    $r = Invoke-Git @('rev-parse', "$Ref`:$RelativePath") -AllowFailure
    if ($r.ExitCode -ne 0) { return $null }
    $line = First-Line $r
    if ($line) { return $line }
    return $null
}

function Worktree-Blob([string]$RelativePath) {
    $full = Join-Path $script:Repo $RelativePath
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { return $null }
    return First-Line (Invoke-Git @('hash-object', "--path=$RelativePath", '--', $RelativePath)) -Required
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
    if ($code -ne 0) { throw "pm2 pid $Name falhou (exit $code): $($stderr -join [Environment]::NewLine)" }
    $numeric = @($stdout | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ -match '^\d+$' })
    if ($numeric.Count -eq 0) { return 0 }
    return [int]$numeric[$numeric.Count - 1]
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
    return $false
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
        return [pscustomobject]@{ quickCheck = $parts[0]; foreignKeyViolations = [int]$parts[1] }
    }
    finally {
        if ($null -eq $oldNodePath) { Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue } else { $env:NODE_PATH = $oldNodePath }
        Remove-Item -LiteralPath $js -Force -ErrorAction SilentlyContinue
    }
}

function Backup-LiveDatabase([string]$Source, [string]$Destination, [string]$CandidateRoot) {
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
        return [pscustomobject]@{ integrity = $parts[0]; bytes = [int64]$parts[1]; method = $parts[2] }
    }
    finally {
        if ($null -eq $oldNodePath) { Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue } else { $env:NODE_PATH = $oldNodePath }
        Remove-Item -LiteralPath $js -Force -ErrorAction SilentlyContinue
    }
}

$script:Repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$original = (Get-Location).Path
$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
if (-not $BackupRoot) { $BackupRoot = Join-Path (Split-Path -Parent $script:Repo) 'clover-rpg-release-backups' }
$backupDir = Join-Path ([System.IO.Path]::GetFullPath($BackupRoot)) "player-stability-activation-$timestamp"
$dbBackup = Join-Path $backupDir 'banco.sqlite'
$tempWorktree = Join-Path ([System.IO.Path]::GetTempPath()) ("clover-player-stability-activation-" + [guid]::NewGuid().ToString('N'))
$worktreeCreated = $false
$restartIssued = $false

try {
    foreach ($cmd in @('git','node','pm2')) { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd nao encontrado no PATH." } }
    if (-not (Test-Path -LiteralPath (Join-Path $script:Repo '.git'))) { throw 'RepoRoot nao e checkout Git.' }
    Set-Location $script:Repo

    Write-Host '1/8 Validando hashes 7/7 candidata e 10/10 hotfixes...' -ForegroundColor Cyan
    Invoke-Git @('fetch','origin',$ReleaseBranch,$SnapshotBranch) | Out-Null
    $head = First-Line (Invoke-Git @('rev-parse','HEAD')) -Required
    if ($head -ne $ExpectedLiveHead) { throw "HEAD vivo mudou: esperado $ExpectedLiveHead, atual $head" }
    foreach ($commit in @($CandidateCommit,$SnapshotCommit)) {
        if ((Invoke-Git @('cat-file','-e',"$commit`^{commit}") -AllowFailure).ExitCode -ne 0) { throw "Commit pinado indisponivel: $commit" }
    }
    foreach ($path in $CandidatePaths) {
        $live = Worktree-Blob $path
        $candidate = Git-BlobAt $CandidateCommit $path
        if (-not $live -or -not $candidate -or $live -ne $candidate) { throw "Arquivo candidata divergiu antes da ativacao: $path" }
    }
    foreach ($path in $HotfixPaths) {
        $live = Worktree-Blob $path
        $snapshot = Git-BlobAt $SnapshotCommit $path
        if (-not $live -or -not $snapshot -or $live -ne $snapshot) { throw "Hotfix divergiu antes da ativacao: $path" }
    }
    Write-Host 'CANDIDATE_FILES_OK=7' -ForegroundColor Green
    Write-Host 'HOTFIX_FILES_OK=10' -ForegroundColor Green

    Write-Host '2/8 Verificando PIDs e health antes da ativacao...' -ForegroundColor Cyan
    $cloverPidBefore = Get-Pm2Pid 'clover-rpg'
    $mudzapPidBefore = Get-Pm2Pid 'mudzap'
    if ($cloverPidBefore -le 0) { throw 'clover-rpg nao tem PID ativo antes da ativacao.' }
    if (-not (Wait-Health 10)) { throw 'Health local nao responde antes da ativacao.' }
    Write-Host "CLOVER_PID_BEFORE=$cloverPidBefore" -ForegroundColor DarkGray
    Write-Host "MUDZAP_PID_BEFORE=$mudzapPidBefore" -ForegroundColor DarkGray

    Write-Host '3/8 Criando worktree temporario do commit testado...' -ForegroundColor Cyan
    Invoke-Git @('worktree','add','--detach',$tempWorktree,$CandidateCommit) | Out-Null
    $worktreeCreated = $true

    Write-Host '4/8 Verificando banco e criando backup consistente...' -ForegroundColor Cyan
    $sourceDb = Join-Path $script:Repo 'banco.sqlite'
    $dbBefore = Inspect-Sqlite $sourceDb
    if ($dbBefore.quickCheck -ne 'ok' -or $dbBefore.foreignKeyViolations -ne 0) { throw "Banco vivo recusado: quick=$($dbBefore.quickCheck) fk=$($dbBefore.foreignKeyViolations)" }
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $backup = Backup-LiveDatabase $sourceDb $dbBackup $tempWorktree
    $backupCheck = Inspect-Sqlite $dbBackup
    if ($backupCheck.quickCheck -ne 'ok' -or $backupCheck.foreignKeyViolations -ne 0) { throw 'Backup SQLite falhou verificacao final.' }
    Write-Host "BACKUP_DB=$dbBackup" -ForegroundColor Green
    Write-Host "BACKUP_METHOD=$($backup.method)" -ForegroundColor DarkGray

    Write-Host '5/8 Reiniciando SOMENTE clover-rpg para carregar os 7 arquivos...' -ForegroundColor Cyan
    Restart-Clover
    $restartIssued = $true

    Write-Host '6/8 Aguardando health e novo PID Clover...' -ForegroundColor Cyan
    if (-not (Wait-Health 45)) { throw 'Health local nao voltou em ate 45s.' }
    $cloverPidAfter = Get-Pm2Pid 'clover-rpg'
    if ($cloverPidAfter -le 0) { throw 'clover-rpg nao tem PID ativo apos restart.' }
    if ($cloverPidAfter -eq $cloverPidBefore) { throw 'PID do clover-rpg nao mudou apos restart; ativacao nao comprovada.' }
    Write-Host "CLOVER_PID_AFTER=$cloverPidAfter" -ForegroundColor Green

    Write-Host '7/8 Confirmando Mudzap intacto...' -ForegroundColor Cyan
    $mudzapPidAfter = Get-Pm2Pid 'mudzap'
    if ($mudzapPidAfter -ne $mudzapPidBefore) { throw "PID do Mudzap mudou: antes=$mudzapPidBefore depois=$mudzapPidAfter" }
    Write-Host "MUDZAP_PID_AFTER=$mudzapPidAfter" -ForegroundColor Green

    Write-Host '8/8 Verificando banco vivo apos restart...' -ForegroundColor Cyan
    $dbAfter = Inspect-Sqlite $sourceDb
    if ($dbAfter.quickCheck -ne 'ok' -or $dbAfter.foreignKeyViolations -ne 0) { throw "Banco pos-restart invalido: quick=$($dbAfter.quickCheck) fk=$($dbAfter.foreignKeyViolations)" }

    Write-Host 'PLAYER_STABILITY_ACTIVATION=PASS' -ForegroundColor Green
    Write-Host "CANDIDATE_HEAD=$CandidateCommit"
    Write-Host 'CODE_FILES_ALREADY_CANDIDATE=7'
    Write-Host 'CODE_FILES_COPIED=0'
    Write-Host 'CLOVER_RESTARTED=1'
    Write-Host 'WEEK_REPAIR_APPLIED=0'
    Write-Host 'STAR_BACKFILL_APPLIED=0'
    Write-Host 'MUDZAP_TOUCHED=0'
    Write-Host 'RAID_TOUCHED=0'
    Write-Host "BACKUP_DIR=$backupDir"
}
catch {
    Write-Host "ACTIVATION_ERROR=$($_.Exception.Message)" -ForegroundColor Red
    if ($restartIssued) {
        Write-Host 'ATENCAO: restart do Clover foi emitido; nenhum arquivo foi copiado e nenhum repair/backfill foi executado.' -ForegroundColor Yellow
    }
    throw
}
finally {
    if ($worktreeCreated -and (Test-Path -LiteralPath $tempWorktree)) {
        try { Invoke-Git @('worktree','remove','--force',$tempWorktree) | Out-Null } catch { Remove-Item -LiteralPath $tempWorktree -Recurse -Force -ErrorAction SilentlyContinue }
    }
    Set-Location $original
}
