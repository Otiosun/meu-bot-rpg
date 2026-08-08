param(
    [string]$RepoRoot = 'C:\Users\natan\Documents\meu-bot-rpg',
    [switch]$FetchRefs
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
    $output = & git @Arguments 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0 -and -not $AllowFailure) {
        throw "git $($Arguments -join ' ') falhou: $($output -join [Environment]::NewLine)"
    }
    [pscustomobject]@{ ExitCode = $code; Output = @($output) }
}

function Worktree-Sha256([string]$Relative) {
    $path = Join-Path $repo $Relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Git-Blob([string]$Ref, [string]$Relative) {
    $result = Invoke-Git @('rev-parse', "$Ref`:$Relative") -AllowFailure
    if ($result.ExitCode -ne 0 -or -not $result.Output.Count) { return $null }
    ([string]$result.Output[0]).Trim()
}

try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git nao foi encontrado no PATH.' }
    if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) { throw 'RepoRoot nao e um checkout Git.' }
    Set-Location $repo

    if ($FetchRefs) {
        Write-Host 'Atualizando somente refs; nenhum checkout/reset sera executado.' -ForegroundColor DarkGray
        Invoke-Git @('fetch', '--prune', 'origin', 'main', 'release/player-stability-20260808') | Out-Null
    }

    $availableRefs = @()
    foreach ($ref in $refs) {
        $probe = Invoke-Git @('rev-parse', '--verify', '--quiet', $ref) -AllowFailure
        if ($probe.ExitCode -eq 0) { $availableRefs += $ref }
    }
    if ($availableRefs -notcontains $releaseRef) {
        throw "Ref candidata ausente: $releaseRef. Rode novamente com -FetchRefs."
    }

    $head = ([string](Invoke-Git @('rev-parse', 'HEAD')).Output[0]).Trim()
    $branch = ([string](Invoke-Git @('branch', '--show-current')).Output[0]).Trim()
    $dirty = @((Invoke-Git ((@('status', '--porcelain=v1', '--untracked-files=no', '--')) + $scopes)).Output)

    $interesting = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($lineValue in $dirty) {
        $line = [string]$lineValue
        if ($line.Length -ge 4) { [void]$interesting.Add($line.Substring(3).Trim()) }
    }
    foreach ($ref in $availableRefs) {
        $names = Invoke-Git ((@('diff', '--name-only', $ref, '--')) + $scopes) -AllowFailure
        foreach ($nameValue in $names.Output) {
            $name = ([string]$nameValue).Trim()
            if ($name) { [void]$interesting.Add($name) }
        }
    }

    $files = @()
    foreach ($relative in @($interesting) | Sort-Object) {
        $worktreeBlobResult = Invoke-Git @('hash-object', '--', $relative) -AllowFailure
        $entry = [ordered]@{
            path = $relative
            worktreeSha256 = Worktree-Sha256 $relative
            worktreeGitBlob = if ($worktreeBlobResult.ExitCode -eq 0 -and $worktreeBlobResult.Output.Count) { ([string]$worktreeBlobResult.Output[0]).Trim() } else { $null }
            refs = [ordered]@{}
        }
        foreach ($ref in $availableRefs) { $entry.refs[$ref] = Git-Blob $ref $relative }
        $files += [pscustomobject]$entry
    }

    $report = [ordered]@{
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        repo = $repo
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

    $out = Join-Path $repo 'player-stability-runtime-delta-sanitized.json'
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $out -Encoding UTF8
    Write-Host "Relatorio sanitizado criado: $out" -ForegroundColor Green
    Write-Host "Arquivos relevantes/divergentes: $($files.Count)"
    Write-Host 'Nenhum banco, PM2, sessao, JID, telefone, credencial ou conteudo de codigo foi emitido.' -ForegroundColor DarkGray
}
finally {
    Set-Location $original
}
