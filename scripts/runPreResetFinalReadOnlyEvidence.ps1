param(
    [string]$RepoRoot = 'C:\Users\natan\Documents\meu-bot-rpg',
    [string]$TargetSha = '19c687f0d1b01ec326af55a1de34bab8c618ae3e',
    [string]$SqliteCopyPath,
    [string]$RosterInputPath,
    [string]$AuthRoot,
    [string]$CampaignKey = 'mythic_launch_v1',
    [string]$OutputRoot = (Join-Path $env:LOCALAPPDATA 'CloverPreResetEvidence')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name nao foi encontrado no PATH."
    }
}

function Invoke-Git([string[]]$Arguments, [string]$WorkingDirectory) {
    & git -C $WorkingDirectory @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') falhou com exit code $LASTEXITCODE."
    }
}

function Invoke-Recorded([string]$Label, [string]$Command, [string]$WorkingDirectory, [string]$OutputFile, [string[]]$Arguments) {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Push-Location $WorkingDirectory
    try {
        & $Command @Arguments *> $OutputFile
        return $LASTEXITCODE
    }
    finally {
        Pop-Location
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function Resolve-ExistingFile([string]$Value, [string]$ParameterName) {
    if (-not $Value) { return $null }
    if (-not (Test-Path -LiteralPath $Value -PathType Leaf)) {
        throw "$ParameterName nao aponta para um arquivo existente."
    }
    return (Resolve-Path -LiteralPath $Value).Path
}

function Resolve-ExistingDirectory([string]$Value, [string]$ParameterName) {
    if (-not $Value) { return $null }
    if (-not (Test-Path -LiteralPath $Value -PathType Container)) {
        throw "$ParameterName nao aponta para um diretorio existente."
    }
    return (Resolve-Path -LiteralPath $Value).Path
}

function Find-SingleRosterInput {
    $roots = @(
        [Environment]::GetFolderPath('Desktop'),
        (Join-Path $env:USERPROFILE 'Downloads')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }
    $matches = foreach ($root in $roots) {
        Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '(?i)(keep.*roster|roster.*keep|prereset.*roster)' }
    }
    $unique = @($matches | Sort-Object -Property FullName -Unique)
    if ($unique.Count -eq 1) { return $unique[0].FullName }
    if ($unique.Count -gt 1) {
        $names = $unique | ForEach-Object { $_.FullName }
        throw "Foram encontrados varios rosters privados possiveis. Informe -RosterInputPath explicitamente:`n$($names -join "`n")"
    }
    return $null
}

function Find-SingleCredibleAuthRoot([string]$RepoPath) {
    $roots = New-Object System.Collections.Generic.List[string]
    $roots.Add((Join-Path $RepoPath 'auth_info'))
    $roots.Add((Join-Path (Split-Path -Parent $RepoPath) 'auth_info'))
    $documents = Join-Path $env:USERPROFILE 'Documents'
    if (Test-Path -LiteralPath $documents -PathType Container) {
        $roots.Add((Join-Path $documents 'Bot-MudaeZap\auth_info'))
        Get-ChildItem -LiteralPath $documents -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $roots.Add((Join-Path $_.FullName 'auth_info'))
        }
    }
    $credible = @($roots | Where-Object {
        if (-not (Test-Path -LiteralPath $_ -PathType Container)) { return $false }
        return @(Get-ChildItem -LiteralPath $_ -Filter 'lid-mapping-*_reverse.json' -File -ErrorAction SilentlyContinue).Count -gt 0
    } | ForEach-Object { (Resolve-Path -LiteralPath $_).Path } | Sort-Object -Unique)
    if ($credible.Count -eq 1) { return $credible[0] }
    if ($credible.Count -gt 1) {
        throw "Foram encontrados varios AUTH roots crediveis. Informe -AuthRoot explicitamente:`n$($credible -join "`n")"
    }
    return $null
}

function New-PrivateOutputDirectory([string]$BasePath) {
    if (-not (Test-Path -LiteralPath $BasePath)) {
        New-Item -ItemType Directory -Path $BasePath -Force | Out-Null
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $directory = Join-Path $BasePath "prereset-final-readonly-$stamp"
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    return $directory
}

Require-Command 'git'
Require-Command 'node'
Require-Command 'npm'

$repo = (Resolve-ExistingDirectory $RepoRoot 'RepoRoot')
if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) {
    throw 'RepoRoot nao e um checkout Git esperado.'
}
if ($env:PRE_RESET -eq 'ON') {
    throw 'PRE_RESET=ON no ambiente atual. O runner read-only foi recusado.'
}
$env:PRE_RESET = 'OFF'
$env:NODE_ENV = 'test'
$env:npm_config_audit = 'false'
$env:npm_config_fund = 'false'

$sqlite = $null
$roster = $null
$auth = $null

$outputDir = New-PrivateOutputDirectory $OutputRoot
$summaryPath = Join-Path $outputDir 'summary.json'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('clover-prereset-final-readonly-' + [guid]::NewGuid().ToString('N'))
$worktreeAdded = $false
$originalLocation = (Get-Location).Path
$summary = [ordered]@{
    status = 'BLOCKED'
    targetSha = $TargetSha
    actualSha = $null
    preReset = $env:PRE_RESET
    sqliteShaBefore = $null
    sqliteShaAfter = $null
    rosterProvided = $false
    authRootProvided = $false
    reports = [ordered]@{}
    blockers = @()
}

try {
    $sqlite = Resolve-ExistingFile $SqliteCopyPath 'SqliteCopyPath'
    if (-not $sqlite) {
        throw 'Informe -SqliteCopyPath com uma COPIA SQLite descartavel; o runner nunca usa banco live.'
    }
    $runtimeDb = Join-Path $repo 'banco.sqlite'
    $runtimeDbResolved = if (Test-Path -LiteralPath $runtimeDb -PathType Leaf) {
        (Resolve-Path -LiteralPath $runtimeDb).Path
    } else { $null }
    if ($runtimeDbResolved -and (Resolve-Path -LiteralPath $sqlite).Path -eq $runtimeDbResolved) {
        throw 'SqliteCopyPath aponta para banco.sqlite do runtime. Forneca uma copia descartavel fora do checkout.'
    }
    $summary.sqliteShaBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $sqlite).Hash.ToLowerInvariant()

    $roster = Resolve-ExistingFile $RosterInputPath 'RosterInputPath'
    if (-not $roster) { $roster = Find-SingleRosterInput }
    $auth = Resolve-ExistingDirectory $AuthRoot 'AuthRoot'
    if (-not $auth) { $auth = Find-SingleCredibleAuthRoot $repo }
    $summary.rosterProvided = [bool]$roster
    $summary.authRootProvided = [bool]$auth

    Invoke-Git @('fetch', '--prune', 'origin', '+refs/heads/codex/prereset-finalization-20260828:refs/remotes/origin/codex/prereset-finalization-20260828') $repo
    $remoteHead = (& git -C $repo rev-parse 'origin/codex/prereset-finalization-20260828').Trim()
    if ($remoteHead -ne $TargetSha) {
        throw "A branch remota nao esta no SHA exigido. Esperado $TargetSha, atual $remoteHead."
    }
    Invoke-Git @('worktree', 'add', '--detach', $tempRoot, $TargetSha) $repo
    $worktreeAdded = $true
    $actualSha = (& git -C $tempRoot rev-parse HEAD).Trim()
    if ($actualSha -ne $TargetSha) {
        throw "Worktree temporario divergiu do SHA exigido. Esperado $TargetSha, atual $actualSha."
    }
    $summary.actualSha = $actualSha

    $npmExit = Invoke-Recorded 'npm ci' 'npm' $tempRoot (Join-Path $outputDir 'npm-ci.txt') @('ci', '--no-audit', '--no-fund')
    if ($npmExit -ne 0) { throw 'npm ci no worktree temporario falhou.' }

    $suiteArgs = @('--test',
        'tests/preResetTransitionService.test.js',
        'tests/preResetCharacterLaunchFoundation.test.js',
        'tests/preResetF6F9LaunchGates.test.js',
        'tests/preResetF10AdminRosterLaunch.test.js',
        'tests/preResetF11Hardening.test.js',
        'tests/preResetF11AdminAccess.test.js',
        'tests/preResetTransitionAdminHttp.test.js',
        'tests/preResetRosterReadOnlyResolver.test.js',
        'tests/preResetRosterAuthReadOnlyResolver.test.js',
        'tests/resetSnapshotIntegrityRoundTrip.test.js',
        'tests/resetGoNoGoSmoke.test.js',
        'tests/preResetLaunchPreviewReadOnly.test.js')
    $suiteExit = Invoke-Recorded 'F6-F12 suite' 'node' $tempRoot (Join-Path $outputDir 'f6-f12-tests.txt') $suiteArgs
    $summary.reports.f6F12Tests = Join-Path $outputDir 'f6-f12-tests.txt'
    if ($suiteExit -ne 0) { throw 'Suite F6-F12 falhou.' }

    $previewExit = Invoke-Recorded 'launch preview' 'node' $tempRoot (Join-Path $outputDir 'launch-preview.json') @(
        'scripts/previewPreResetLaunchReadOnly.js', "--db=$sqlite", "--campaign=$CampaignKey"
    )
    $summary.reports.launchPreview = Join-Path $outputDir 'launch-preview.json'
    if ($previewExit -gt 2) { throw "Preview read-only falhou com exit code $previewExit." }
    if ($previewExit -eq 2) { $summary.blockers += 'launch_preview_requires_review_or_policy' }

    if ($roster -and $auth) {
        $resolverExit = Invoke-Recorded 'AUTH resolver' 'node' $tempRoot (Join-Path $outputDir 'auth-resolver-private.json') @(
            'scripts/resolvePreResetKeepRosterWithAuthReadOnly.js', "--db=$sqlite", "--input=$roster", "--auth-root=$auth"
        )
        $summary.reports.authResolver = Join-Path $outputDir 'auth-resolver-private.json'
        if ($resolverExit -gt 2) { throw "Resolver AUTH read-only falhou com exit code $resolverExit." }
        if ($resolverExit -eq 2) { $summary.blockers += 'roster_not_fully_resolved' }
    } else {
        $summary.blockers += 'private_roster_or_auth_root_unavailable'
    }

    $summary.sqliteShaAfter = (Get-FileHash -Algorithm SHA256 -LiteralPath $sqlite).Hash.ToLowerInvariant()
    if ($summary.sqliteShaBefore -ne $summary.sqliteShaAfter) {
        throw 'SHA do SQLite mudou durante evidencia read-only.'
    }
    $summary.status = if ($summary.blockers.Count -eq 0) { 'PASS' } else { 'BLOCKED' }
}
catch {
    $message = $_.Exception.Message
    $summary.status = if ($message -match 'varios (AUTH roots|rosters)|SqliteCopyPath|private') { 'BLOCKED' } else { 'FAIL' }
    $summary.blockers += $message
    try { $summary.sqliteShaAfter = (Get-FileHash -Algorithm SHA256 -LiteralPath $sqlite).Hash.ToLowerInvariant() } catch {}
}
finally {
    Set-Location $originalLocation
    if ($worktreeAdded -and (Test-Path -LiteralPath $tempRoot)) {
        & git -C $repo worktree remove $tempRoot 2>$null
        if ($LASTEXITCODE -ne 0) {
            $summary.blockers += "worktree_cleanup_required:$tempRoot"
            if ($summary.status -eq 'PASS') { $summary.status = 'BLOCKED' }
        }
    }
    $summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryPath -Encoding utf8
}

Write-Host "PRERESET_FINAL_READONLY_EVIDENCE=$($summary.status)"
Write-Host "OUTPUT_DIR=$outputDir"
Write-Host "SUMMARY=$summaryPath"
Write-Host "SQLITE_SHA_BEFORE=$($summary.sqliteShaBefore)"
Write-Host "SQLITE_SHA_AFTER=$($summary.sqliteShaAfter)"
if ($summary.blockers.Count) { Write-Host "BLOCKERS=$($summary.blockers -join ';')" }
if ($summary.status -eq 'FAIL') { exit 1 }
if ($summary.status -eq 'BLOCKED') { exit 2 }
