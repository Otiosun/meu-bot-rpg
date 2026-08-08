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
    return [pscustomobject]@{
        ExitCode = $code
        Output = @($output)
    }
}

function Worktree-Sha256([string]$relative) {
    $path = Join-Path $repo $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Git-Blob([string]$ref, [string]$relative) {
    $result = Invoke-Git @('rev-parse', "$ref`:$relative") -AllowFailure
    if ($result.ExitCode -ne 0 -or -not $result.Output.Count) { return $null }
    return ([string]$result.Output[0]).Trim()
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
        $fetch = Invoke-Git @(
            'fetch', '--prune', 'origin',
            'main',
            'fix/weekly-scene-date-v3',
            'feature/raid-persistent-idempotency-v1',
            'feature/admin-rewards-v2'
        )
        if ($fetch.ExitCode -ne 0) { throw 'Falha ao atualizar refs remotas.' }
    }

    $headResult = Invoke-Git @('rev-parse', 'HEAD')
    $branchResult = Invoke-Git @('branch', '--show-current')
    $head = ([string]$headResult.Output[0]).Trim()
    $branch = ([string]$branchResult.Output[0]).Trim()
    $dirtyResult = Invoke-Git ((@('status', '--porcelain=v1', '--untracked-files=no', '--')) + $scopes)
    $dirty = @($dirtyResult.Output)

    $availableRefs = @()
    foreach ($ref in $candidateRefs) {
        $probe = Invoke-Git @('rev-parse', '--verify', '--quiet', $ref) -AllowFailure
        if ($probe.ExitCode -eq 0) { $availableRefs += $ref }
    }

    $interesting = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($lineValue in $dirty) {
        $line = [string]$lineValue
        if ($line.Length -ge 4) { [void]$interesting.Add($line.Substring(3).Trim()) }
    }
    foreach ($ref in $availableRefs) {
        $namesResult = Invoke-Git ((@('diff', '--name-only', $ref, '--')) + $scopes) -AllowFailure
        foreach ($nameValue in $namesResult.Output) {
            $clean = ([string]$nameValue).Trim()
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
        if ($worktreeBlob.ExitCode -eq 0 -and $worktreeBlob.Output.Count) {
            $entry.worktreeGitBlob = ([string]$worktreeBlob.Output[0]).Trim()
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
