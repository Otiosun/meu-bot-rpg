param(
    [string]$RepoRoot = 'C:\Users\natan\Documents\meu-bot-rpg',
    [string]$Remote = 'origin',
    [string]$SnapshotBranch = 'runtime-hotfix-snapshot-20260808-923d05b'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$expectedPaths = @(
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
    $stdoutPath = Join-Path ([System.IO.Path]::GetTempPath()) ("clover-git-stdout-" + [guid]::NewGuid().ToString('N') + '.txt')
    $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) ("clover-git-stderr-" + [guid]::NewGuid().ToString('N') + '.txt')
    try {
        $process = Start-Process -FilePath 'git' -ArgumentList $Arguments -WorkingDirectory $script:repo -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        $stdout = if (Test-Path -LiteralPath $stdoutPath) { @(Get-Content -LiteralPath $stdoutPath) } else { @() }
        $stderr = if (Test-Path -LiteralPath $stderrPath) { @(Get-Content -LiteralPath $stderrPath) } else { @() }
        if ($process.ExitCode -ne 0 -and -not $AllowFailure) {
            throw "git $($Arguments -join ' ') falhou (exit $($process.ExitCode)): $($stderr -join [Environment]::NewLine)"
        }
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout; Stderr = $stderr }
    }
    finally {
        Remove-Item -LiteralPath $stdoutPath,$stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function First-Line($Result) {
    $values = @($Result.Stdout | Where-Object { $null -ne $_ -and ([string]$_).Trim() })
    if ($values.Count -eq 0) { return '' }
    return ([string]$values[0]).Trim()
}

$script:repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$original = (Get-Location).Path
$tempIndex = Join-Path ([System.IO.Path]::GetTempPath()) ("clover-runtime-hotfix-" + [guid]::NewGuid().ToString('N') + '.index')
$oldIndex = $env:GIT_INDEX_FILE
$oldAuthorName = $env:GIT_AUTHOR_NAME
$oldAuthorEmail = $env:GIT_AUTHOR_EMAIL
$oldCommitterName = $env:GIT_COMMITTER_NAME
$oldCommitterEmail = $env:GIT_COMMITTER_EMAIL

try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git nao encontrado no PATH.' }
    if (-not (Test-Path -LiteralPath (Join-Path $script:repo '.git'))) { throw 'RepoRoot nao e um checkout Git.' }
    Set-Location $script:repo

    $head = First-Line (Invoke-Git @('rev-parse', 'HEAD'))
    if ($head -ne '923d05b66883e39510c68e14a109b005950d6cfc') {
        throw "Snapshot recusado: HEAD vivo mudou. Esperado 923d05b..., atual $head. Rode o preflight novamente."
    }

    $status = Invoke-Git @('status', '--porcelain=v1', '--untracked-files=no')
    $dirtyPaths = @()
    foreach ($lineValue in $status.Stdout) {
        $line = [string]$lineValue
        if ($line.Length -lt 4) { continue }
        $path = $line.Substring(3).Trim()
        if ($path) { $dirtyPaths += $path }
    }
    $dirtyPaths = @($dirtyPaths | Sort-Object -Unique)
    $expectedSorted = @($expectedPaths | Sort-Object -Unique)
    $unexpected = @($dirtyPaths | Where-Object { $expectedSorted -notcontains $_ })
    $missing = @($expectedSorted | Where-Object { $dirtyPaths -notcontains $_ })
    if ($unexpected.Count -gt 0 -or $missing.Count -gt 0) {
        throw "Snapshot recusado: conjunto de arquivos modificados mudou. Extras=[$($unexpected -join ', ')] Ausentes=[$($missing -join ', ')]. Rode o preflight novamente."
    }

    foreach ($path in $expectedPaths) {
        if (-not (Test-Path -LiteralPath (Join-Path $script:repo $path) -PathType Leaf)) {
            throw "Snapshot recusado: arquivo esperado ausente: $path"
        }
    }

    $remoteUrl = First-Line (Invoke-Git @('remote', 'get-url', $Remote))
    if ($remoteUrl -notmatch 'github\.com[:/]Otiosun/meu-bot-rpg(?:\.git)?$') {
        throw "Snapshot recusado: remote inesperado: $remoteUrl"
    }

    $existing = Invoke-Git @('ls-remote', '--heads', $Remote, "refs/heads/$SnapshotBranch") -AllowFailure
    if ($existing.ExitCode -ne 0) { throw 'Nao foi possivel consultar o remote.' }
    if ((First-Line $existing)) {
        throw "Snapshot recusado: branch remota ja existe ($SnapshotBranch). Nenhum force push sera feito."
    }

    Write-Host 'Criando indice Git temporario; indice/worktree vivos nao serao alterados...' -ForegroundColor Cyan
    $env:GIT_INDEX_FILE = $tempIndex
    Invoke-Git @('read-tree', $head) | Out-Null
    foreach ($path in $expectedPaths) {
        Invoke-Git @('add', '--', $path) | Out-Null
    }
    $tree = First-Line (Invoke-Git @('write-tree'))
    if (-not $tree) { throw 'Falha ao criar tree do snapshot.' }

    $env:GIT_AUTHOR_NAME = 'Clover Runtime Snapshot'
    $env:GIT_AUTHOR_EMAIL = 'runtime-snapshot@localhost'
    $env:GIT_COMMITTER_NAME = 'Clover Runtime Snapshot'
    $env:GIT_COMMITTER_EMAIL = 'runtime-snapshot@localhost'
    $commit = First-Line (Invoke-Git @('commit-tree', $tree, '-p', $head, '-m', 'snapshot: preserve live tracked hotfixes before player stability release'))
    if (-not $commit) { throw 'Falha ao criar commit do snapshot.' }

    Write-Host "Enviando snapshot para branch privada $SnapshotBranch..." -ForegroundColor Cyan
    Invoke-Git @('push', $Remote, "$commit`:refs/heads/$SnapshotBranch") | Out-Null

    Write-Host "RUNTIME_HOTFIX_SNAPSHOT=PASS" -ForegroundColor Green
    Write-Host "SNAPSHOT_BRANCH=$SnapshotBranch"
    Write-Host "SNAPSHOT_COMMIT=$commit"
    Write-Host "BASE_HEAD=$head"
    Write-Host "TRACKED_FILES=$($expectedPaths.Count)"
    Write-Host 'Nenhum checkout/reset/stash foi feito; indice real, SQLite, PM2, Mudzap e Raid permaneceram intocados.' -ForegroundColor DarkGray
}
finally {
    if ($null -eq $oldIndex) { Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue } else { $env:GIT_INDEX_FILE = $oldIndex }
    if ($null -eq $oldAuthorName) { Remove-Item Env:GIT_AUTHOR_NAME -ErrorAction SilentlyContinue } else { $env:GIT_AUTHOR_NAME = $oldAuthorName }
    if ($null -eq $oldAuthorEmail) { Remove-Item Env:GIT_AUTHOR_EMAIL -ErrorAction SilentlyContinue } else { $env:GIT_AUTHOR_EMAIL = $oldAuthorEmail }
    if ($null -eq $oldCommitterName) { Remove-Item Env:GIT_COMMITTER_NAME -ErrorAction SilentlyContinue } else { $env:GIT_COMMITTER_NAME = $oldCommitterName }
    if ($null -eq $oldCommitterEmail) { Remove-Item Env:GIT_COMMITTER_EMAIL -ErrorAction SilentlyContinue } else { $env:GIT_COMMITTER_EMAIL = $oldCommitterEmail }
    Remove-Item -LiteralPath $tempIndex -Force -ErrorAction SilentlyContinue
    Set-Location $original
}
