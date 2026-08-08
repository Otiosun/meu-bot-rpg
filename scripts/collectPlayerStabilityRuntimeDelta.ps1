param(
    [string]$RepoRoot = 'C:\Users\natan\Documents\meu-bot-rpg',
    [switch]$FetchRefs,
    [string]$OutputPath = (Join-Path ([System.IO.Path]::GetTempPath()) 'player-stability-runtime-delta-sanitized.json')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$original = (Get-Location).Path
$releaseRef = 'origin/release/player-stability-20260808'
$refs = @('origin/main', $releaseRef)
$scopes = @(
    'helpers/clover',
    'database.js',
    'siteApiServer.js',
    'helpers/groupAccess.js',
    'ecosystem.clover.config.cjs',
    'package.json'
)

function Invoke-Git([string[]]$Arguments, [switch]$AllowFailure) {
    $stderrFile = [System.IO.Path]::GetTempFileName()
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 can turn harmless native stderr warnings into
        # NativeCommandError when ErrorActionPreference=Stop. Keep stdout and
        # stderr separate so warnings never pollute hashes/paths either.
        $ErrorActionPreference = 'Continue'
        $stdout = @(& git @Arguments 2> $stderrFile)
        $code = $LASTEXITCODE
        $stderr = if (Test-Path -LiteralPath $stderrFile) {
            @(Get-Content -LiteralPath $stderrFile -ErrorAction SilentlyContinue)
        } else {
            @()
        }
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue
    }

    if ($code -ne 0 -and -not $AllowFailure) {
        $details = if ($stderr.Count) { $stderr -join [Environment]::NewLine } else { $stdout -join [Environment]::NewLine }
        throw "git $($Arguments -join ' ') falhou: $details"
    }

    [pscustomobject]@{
        ExitCode = $code
        Output = @($stdout)
        Stderr = @($stderr)
    }
}

function Get-FirstGitLine($Result, [switch]$Required) {
    $values = @($Result.Output | Where-Object { $null -ne $_ -and ([string]$_).Trim() })
    if ($values.Count -eq 0) {
        if ($Required) { throw 'Comando git esperado nao retornou nenhuma linha.' }
        return ''
    }
    return ([string]$values[0]).Trim()
}

function Worktree-Sha256([string]$Relative) {
    $path = Join-Path $repo $Relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Git-Blob([string]$Ref, [string]$Relative) {
    $result = Invoke-Git @('rev-parse', "$Ref`:$Relative") -AllowFailure
    if ($result.ExitCode -ne 0) { return $null }
    $line = Get-FirstGitLine $result
    if (-not $line) { return $null }
    return $line
}

try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git nao foi encontrado no PATH.' }
    if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) { throw 'RepoRoot nao e um checkout Git.' }
    Set-Location $repo

    if ($FetchRefs) {
        Write-Host 'Atualizando somente refs remotas; nenhum checkout/reset sera executado.' -ForegroundColor DarkGray
        Invoke-Git @(
            'fetch', '--prune', 'origin',
            '+refs/heads/main:refs/remotes/origin/main',
            '+refs/heads/release/player-stability-20260808:refs/remotes/origin/release/player-stability-20260808'
        ) | Out-Null
    }

    $availableRefs = @()
    foreach ($ref in $refs) {
        $probe = Invoke-Git @('rev-parse', '--verify', '--quiet', $ref) -AllowFailure
        if ($probe.ExitCode -eq 0) { $availableRefs += $ref }
    }
    if ($availableRefs -notcontains $releaseRef) {
        throw "Ref candidata ausente: $releaseRef. Rode novamente com -FetchRefs."
    }

    $head = Get-FirstGitLine (Invoke-Git @('rev-parse', 'HEAD')) -Required
    $branchProbe = Invoke-Git @('symbolic-ref', '--quiet', '--short', 'HEAD') -AllowFailure
    $branch = if ($branchProbe.ExitCode -eq 0) {
        $branchName = Get-FirstGitLine $branchProbe
        if ($branchName) { $branchName } else { '(detached)' }
    } else {
        '(detached)'
    }
    $dirty = @((Invoke-Git ((@('status', '--porcelain=v1', '--untracked-files=no', '--')) + $scopes)).Output | Where-Object { $null -ne $_ -and ([string]$_).Trim() })

    $interesting = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($lineValue in $dirty) {
        $line = [string]$lineValue
        if ($line.Length -ge 4) { [void]$interesting.Add($line.Substring(3).Trim()) }
    }
    foreach ($ref in $availableRefs) {
        $names = Invoke-Git ((@('diff', '--name-only', $ref, '--')) + $scopes) -AllowFailure
        foreach ($nameValue in @($names.Output | Where-Object { $null -ne $_ -and ([string]$_).Trim() })) {
            $name = ([string]$nameValue).Trim()
            if ($name) { [void]$interesting.Add($name) }
        }
    }

    $files = @()
    foreach ($relative in @($interesting) | Sort-Object) {
        $worktreeBlobResult = Invoke-Git @('hash-object', '--', $relative) -AllowFailure
        $worktreeBlob = if ($worktreeBlobResult.ExitCode -eq 0) { Get-FirstGitLine $worktreeBlobResult } else { '' }
        $entry = [ordered]@{
            path = $relative
            worktreeSha256 = Worktree-Sha256 $relative
            worktreeGitBlob = if ($worktreeBlob) { $worktreeBlob } else { $null }
            refs = [ordered]@{}
        }
        foreach ($ref in $availableRefs) { $entry.refs[$ref] = Git-Blob $ref $relative }
        $files += [pscustomobject]$entry
    }

    $report = [ordered]@{
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        branch = $branch
        head = $head
        candidateRef = $releaseRef
        availableRefs = $availableRefs
        trackedDirty = $dirty
        files = $files
        safety = [ordered]@{
            databaseOpened = $false
            databaseCopied = $false
            pm2Touched = $false
            fileContentsEmitted = $false
            untrackedFilesEnumerated = $false
            checkoutChanged = $false
        }
    }

    $out = [System.IO.Path]::GetFullPath($OutputPath)
    $parent = Split-Path -Parent $out
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $out -Encoding UTF8
    Write-Host "Relatorio sanitizado criado: $out" -ForegroundColor Green
    Write-Host "Arquivos relevantes/divergentes: $($files.Count)"
    Write-Host 'Nenhum banco, PM2, sessao, JID, telefone, credencial, conteudo de codigo ou checkout foi alterado.' -ForegroundColor DarkGray
}
finally {
    Set-Location $original
}
