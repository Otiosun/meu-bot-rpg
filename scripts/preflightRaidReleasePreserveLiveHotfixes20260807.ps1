param(
    [string]$RepoPath = 'C:\Users\natan\Documents\meu-bot-rpg',
    [string]$CandidateRef = 'origin/release/raid-live-hotfix-preservation-v1'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-Sha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Invoke-Git([string[]]$Args, [string]$WorkingDirectory = $RepoPath) {
    $output = & git -C $WorkingDirectory @Args 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Args -join ' ') falhou: $($output -join [Environment]::NewLine)"
    }
    return $output
}

function Get-Pm2Process([string]$Name) {
    $raw = & pm2 jlist 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    $items = $raw | ConvertFrom-Json
    $match = $items | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if (-not $match) { return $null }
    [pscustomobject]@{
        name = $match.name
        pid = [int]$match.pid
        status = [string]$match.pm2_env.status
    }
}

if (-not (Test-Path -LiteralPath $RepoPath -PathType Container)) {
    throw "Repo não encontrado: $RepoPath"
}

$gitDir = (Invoke-Git @('rev-parse', '--git-dir') | Select-Object -First 1)
if (-not $gitDir) { throw 'Diretório não é um repositório Git válido.' }

$liveDb = Join-Path $RepoPath 'banco.sqlite'
if (-not (Test-Path -LiteralPath $liveDb -PathType Leaf)) {
    throw "Banco vivo não encontrado: $liveDb"
}

$before = [ordered]@{
    timestamp = (Get-Date).ToString('o')
    clover = Get-Pm2Process 'clover-rpg'
    mudzap = Get-Pm2Process 'mudzap'
    health = $null
    database = $null
}

try {
    $healthResponse = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 8
    $before.health = [ordered]@{
        statusCode = [int]$healthResponse.StatusCode
        ok = $healthResponse.StatusCode -ge 200 -and $healthResponse.StatusCode -lt 300
    }
} catch {
    $before.health = [ordered]@{ statusCode = 0; ok = $false; error = 'health_unreachable' }
}

$dbProbe = @'
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
(async () => {
  const file = process.argv[1];
  const db = await open({ filename: file, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
  try {
    await db.exec('PRAGMA query_only = ON');
    const quick = await db.get('PRAGMA quick_check');
    const fk = await db.all('PRAGMA foreign_key_check');
    console.log(JSON.stringify({ quickCheck: Object.values(quick || {})[0] || null, foreignKeyViolations: fk.length }));
  } finally {
    await db.close();
  }
})().catch((error) => { console.error(error.message); process.exit(1); });
'@

$dbProbeOutput = & node -e $dbProbe $liveDb 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "Probe SQLite read-only falhou: $($dbProbeOutput -join [Environment]::NewLine)"
}
$before.database = ($dbProbeOutput | Select-Object -Last 1) | ConvertFrom-Json

# Somente rede/Git e worktree temporária a partir daqui. A árvore viva nunca troca de branch.
Invoke-Git @('fetch', '--prune', 'origin', 'release/raid-live-hotfix-preservation-v1') | Out-Null
Invoke-Git @('rev-parse', '--verify', $CandidateRef) | Out-Null

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('clover-raid-preflight-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot | Out-Null

$criticalFiles = @(
    'helpers/clover/skillTreeService.js',
    'comandos/arvores.js',
    'helpers/clover/siteApiServer.js',
    'helpers/clover/canonicalScopedAccessService.js',
    'helpers/clover/adminApiSupport.js'
)

$checks = New-Object System.Collections.Generic.List[object]
$testResults = New-Object System.Collections.Generic.List[object]
$blocking = New-Object System.Collections.Generic.List[string]

try {
    Invoke-Git @('worktree', 'add', '--detach', $tempRoot, $CandidateRef) | Out-Null

    foreach ($relative in $criticalFiles) {
        $livePath = Join-Path $RepoPath $relative
        $candidatePath = Join-Path $tempRoot $relative
        $mainTemp = Join-Path $tempRoot ('.preflight-main-' + [Guid]::NewGuid().ToString('N'))
        try {
            $mainBytes = & git -C $RepoPath show "origin/main:$relative" 2>$null
            if ($LASTEXITCODE -eq 0) {
                [System.IO.File]::WriteAllLines($mainTemp, [string[]]$mainBytes)
            }
            $liveHash = Get-Sha256 $livePath
            $candidateHash = Get-Sha256 $candidatePath
            $mainHash = Get-Sha256 $mainTemp
            $liveDiffersFromMain = $liveHash -and $mainHash -and $liveHash -ne $mainHash
            $candidateMatchesMain = $candidateHash -and $mainHash -and $candidateHash -eq $mainHash
            $wouldOverwriteLocalHotfix = [bool]($liveDiffersFromMain -and $candidateMatchesMain)
            if ($wouldOverwriteLocalHotfix) {
                $blocking.Add("candidate_would_overwrite_live_hotfix:$relative")
            }
            $checks.Add([pscustomobject]@{
                file = $relative
                liveExists = [bool]$liveHash
                candidateExists = [bool]$candidateHash
                liveDiffersFromMain = [bool]$liveDiffersFromMain
                candidateMatchesMain = [bool]$candidateMatchesMain
                wouldOverwriteLocalHotfix = $wouldOverwriteLocalHotfix
            })
        } finally {
            Remove-Item -LiteralPath $mainTemp -Force -ErrorAction SilentlyContinue
        }
    }

    $syntaxFiles = @(
        'helpers/clover/playerIdentityEquivalenceService.js',
        'helpers/clover/canonicalScopedAccessService.js',
        'helpers/clover/skillApprovalService.js',
        'helpers/clover/skillApprovalHttp.js',
        'helpers/clover/siteApiServer.js'
    )
    foreach ($relative in $syntaxFiles) {
        & node --check (Join-Path $tempRoot $relative)
        if ($LASTEXITCODE -ne 0) { throw "node --check falhou: $relative" }
    }

    $focusedTests = @(
        'tests/canonicalLeadershipAliasAccess.test.js',
        'tests/skillApprovalHttp.test.js',
        'tests/raidMutationIdempotency.test.js',
        'tests/raidCreationIdempotency.test.js',
        'tests/raidClaimedMutationIdempotency.test.js',
        'tests/raidIdempotentHttp.test.js',
        'tests/raidFinalizationIdempotentHttp.test.js',
        'tests/raidRewardProposalIdempotentHttp.test.js',
        'tests/raidRewardProposalReviewGuard.test.js'
    )

    Push-Location $tempRoot
    try {
        if (-not (Test-Path -LiteralPath (Join-Path $tempRoot 'node_modules'))) {
            & npm ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'npm ci falhou no worktree temporário.' }
        }
        foreach ($relative in $focusedTests) {
            & node --test $relative
            $passed = $LASTEXITCODE -eq 0
            $testResults.Add([pscustomobject]@{ test = $relative; passed = $passed })
            if (-not $passed) { $blocking.Add("focused_test_failed:$relative") }
        }
    } finally {
        Pop-Location
    }
} finally {
    try { Invoke-Git @('worktree', 'remove', '--force', $tempRoot) | Out-Null } catch {}
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$after = [ordered]@{
    clover = Get-Pm2Process 'clover-rpg'
    mudzap = Get-Pm2Process 'mudzap'
}

if ($before.clover -and $after.clover -and $before.clover.pid -ne $after.clover.pid) {
    $blocking.Add('clover_pid_changed_during_read_only_preflight')
}
if ($before.mudzap -and $after.mudzap -and $before.mudzap.pid -ne $after.mudzap.pid) {
    $blocking.Add('mudzap_pid_changed_during_read_only_preflight')
}
if (-not $before.health.ok) { $blocking.Add('live_health_not_ok_before_preflight') }
if ($before.database.quickCheck -ne 'ok') { $blocking.Add('sqlite_quick_check_not_ok') }
if ([int]$before.database.foreignKeyViolations -ne 0) { $blocking.Add('sqlite_foreign_key_violations') }

$report = [ordered]@{
    ok = $blocking.Count -eq 0
    safeToBlindGitDeploy = $false
    candidateRef = $CandidateRef
    before = $before
    fileCompatibility = $checks
    focusedTests = $testResults
    blockers = @($blocking)
    note = 'Preflight somente leitura. Nenhum banco, PM2 ou branch da arvore viva foi alterado.'
}

$report | ConvertTo-Json -Depth 8
if ($blocking.Count -gt 0) { exit 2 }
exit 0
