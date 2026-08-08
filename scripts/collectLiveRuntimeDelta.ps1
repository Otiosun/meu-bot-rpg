param(
    [string]$RepoRoot = 'C:\Users\natan\Documents\meu-bot-rpg',
    [switch]$FetchRefs
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = (Resolve-Path $RepoRoot).Path
$original = (Get-Location).Path
$scopes = @(
    'helpers/clover',
    'database.js',
    'siteApiServer.js',
    'ecosystem.clover.config.cjs',
    'package.json'
)
$candidateRefs = @(
    'origin/main',
    'origin/fix/weekly-scene-date-v3',
    'origin/feature/raid-persistent-idempotency-v1',
    'origin/feature/admin-rewards-v2'
)

function Invoke-Git([string[]]$Arguments, [switch]$AllowFailure) {
    $output = & git @Arguments 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0 -and -not $AllowFailure) {
        throw "git $($Arguments -join ' ') falhou: $($output -join [Environment]::NewLine)"
    }
    return @($output)
}

function Ref-Exists([string]$ref) {
    & git show-ref --verify --quiet "refs/remotes/$($ref -replace '^origin/', 'origin/')" 2>$null
    if ($LASTEXITCODE -eq 0) { return $true }
    & git rev-parse --verify --quiet $ref *> $null
    return $LASTEXITCODE -eq 0
}

function Worktree-Sha256([string]$relative) {
    $path = Join-Path $repo $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Git-Blob([string]$ref, [string]$relative) {
    $value = Invoke-Git @('rev-parse', "$ref`:$relative") -AllowFailure
    if ($LASTEXITCODE -ne 0 -or -not $value.Count) { return $null }
    return String($value[0]).Trim()
}

try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw 'git nao foi encontrado no PATH.'
    }
    Set-Location $repo
    if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) {
        throw 'O diretorio informado nao e um checkout Git.'
    }

    if ($FetchRefs) {
        Write-Host 'Atualizando apenas refs remotas; nenhum checkout/reset sera executado.' -ForegroundColor DarkGray
        Invoke-Git @('fetch', '--prune', 'origin',
            'main',
            'fix/weekly-scene-date-v3',
            'feature/raid-persistent-idempotency-v1',
            'feature/admin-rewards-v2') | Out-Null
    }

    $head = (Invoke-Git @('rev-parse', 'HEAD'))[0].Trim()
    $branch = (Invoke-Git @('branch', '--show-current'))[0].Trim()
    $dirty = Invoke-Git (@('status', '--porcelain=v1', '--untracked-files=no', '--') + $scopes)

    $availableRefs = @()
    foreach ($ref in $candidateRefs) {
        & git rev-parse --verify --quiet $ref *> $null
        if ($LASTEXITCODE -eq 0) { $availableRefs += $ref }
    }

    $interesting = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($line in $dirty) {
        if ($line.Length -ge 4) { [void]$interesting.Add($line.Substring(3).Trim()) }
    }
    foreach ($ref in $availableRefs) {
        $names = Invoke-Git (@('diff', '--name-only', $ref, '--') + $scopes) -AllowFailure
        foreach ($name in $names) {
            $clean = String($name).Trim()
            if ($clean) { [void]$interesting.Add($clean) }
        }
    }

    $files = @()
    foreach ($relative in @($interesting) | Sort-Object) {
        $entry = [ordered]@{
            path = $relative
            worktreeSha256 = Worktree-Sha256 $relative
            worktreeGitBlob = $null
            refs = [ordered]@{}
        }
        $worktreeBlob = Invoke-Git @('hash-object', '--', $relative) -AllowFailure
        if ($LASTEXITCODE -eq 0 -and $worktreeBlob.Count) {
            $entry.worktreeGitBlob = String($worktreeBlob[0]).Trim()
        }
        foreach ($ref in $availableRefs) {
            $entry.refs[$ref] = Git-Blob $ref $relative
        }
        $files += [pscustomobject]$entry
    }

    $report = [ordered]@{
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        repo = $repo
        branch = $branch
        head = $head
        availableRefs = $availableRefs
        trackedDirty = $dirty
        files = $files
        safety = [ordered]@{
            databaseOpened = $false
            databaseCopied = $false
            pm2Touched = $false
            fileContentsEmitted = $false
            untrackedFilesEnumerated = $false
        }
    }

    $out = Join-Path $repo 'runtime-delta-sanitized.json'
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $out -Encoding UTF8
    Write-Host "Relatorio sanitizado criado: $out" -ForegroundColor Green
    Write-Host "Arquivos de codigo divergentes/relevantes: $($files.Count)"
    Write-Host 'Nenhum conteudo de arquivo, banco, sessao, JID, telefone ou credencial foi lido para o relatorio.' -ForegroundColor DarkGray
}
finally {
    Set-Location $original
}
