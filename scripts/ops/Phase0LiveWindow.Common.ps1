function Assert-Condition {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Assert-LastExitCode {
    param(
        [string]$Message,
        [int[]]$Allowed = @(0)
    )

    if ($Allowed -notcontains $LASTEXITCODE) {
        throw "$Message Código: $LASTEXITCODE"
    }
}

function Get-Sha256 {
    param([string]$Path)

    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-JsonFileExclusive {
    param(
        [string]$Path,
        [object]$Value
    )

    $Parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $Parent -Force | Out-Null
    $Json = $Value | ConvertTo-Json -Depth 30
    $Encoding = New-Object System.Text.UTF8Encoding($false)

    if (Test-Path $Path) {
        throw "O arquivo já existe: $Path"
    }

    [System.IO.File]::WriteAllText($Path, "$Json`n", $Encoding)
}

function Get-CommandPath {
    param([string[]]$Names)

    foreach ($Name in $Names) {
        $Command = Get-Command $Name -ErrorAction SilentlyContinue
        if ($Command) {
            return $Command.Source
        }
    }

    throw "Comando não encontrado: $($Names -join ', ')"
}

function Get-Pm2AppState {
    param(
        [string]$Pm2Command,
        [string]$Name
    )

    $Raw = & $Pm2Command jlist 2>$null | Out-String
    Assert-LastExitCode -Message 'Falha ao consultar o PM2.'

    $Processes = $Raw | ConvertFrom-Json
    $Process = @($Processes) | Where-Object { $_.name -eq $Name } | Select-Object -First 1

    if (-not $Process) {
        return $null
    }

    return [string]$Process.pm2_env.status
}

function Wait-Pm2State {
    param(
        [string]$Pm2Command,
        [string]$Name,
        [string[]]$AllowedStates,
        [int]$Attempts = 30
    )

    for ($Attempt = 1; $Attempt -le $Attempts; $Attempt += 1) {
        $State = Get-Pm2AppState -Pm2Command $Pm2Command -Name $Name
        if ($AllowedStates -contains $State) {
            return $State
        }
        Start-Sleep -Seconds 1
    }

    throw "O PM2 não alcançou o estado esperado para $Name: $($AllowedStates -join ', ')"
}

function Test-HealthEndpoint {
    param(
        [string]$Url,
        [int]$Attempts = 12
    )

    if ([string]::IsNullOrWhiteSpace($Url)) {
        return $true
    }

    for ($Attempt = 1; $Attempt -le $Attempts; $Attempt += 1) {
        try {
            $Response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 10
            if ([int]$Response.StatusCode -ge 200 -and [int]$Response.StatusCode -lt 300) {
                return $true
            }
        }
        catch {
            if ($Attempt -eq $Attempts) {
                return $false
            }
        }
        Start-Sleep -Seconds 2
    }

    return $false
}

function Assert-RuntimeRepository {
    Assert-Condition (Test-Path $RuntimeRepo) "Runtime repo ausente: $RuntimeRepo"
    Assert-Condition (Test-Path $LiveDatabase) "Banco vivo ausente: $LiveDatabase"

    $ActualRuntimeSha = (git -C $RuntimeRepo rev-parse HEAD).Trim()
    Assert-Condition ($ActualRuntimeSha -eq $ExpectedRuntimeSha) "Runtime SHA inesperado: $ActualRuntimeSha"

    git -C $RuntimeRepo diff --quiet --
    Assert-LastExitCode -Message 'Há alterações rastreadas não commitadas no runtime repo.'

    git -C $RuntimeRepo diff --cached --quiet --
    Assert-LastExitCode -Message 'Há alterações rastreadas em stage no runtime repo.'

    return $ActualRuntimeSha
}

function Ensure-DetachedWorktree {
    param(
        [string]$Name,
        [string]$Path,
        [string]$Sha
    )

    if (Test-Path $Path) {
        $Status = git -C $Path status --porcelain
        if ($Status) {
            throw "Worktree sujo: $Path`n$Status"
        }

        git -C $Path checkout --detach $Sha
        Assert-LastExitCode -Message "Falha ao atualizar o worktree $Name."
    }
    else {
        git -C $RuntimeRepo worktree add --detach $Path $Sha
        Assert-LastExitCode -Message "Falha ao criar o worktree $Name."
    }

    $Actual = (git -C $Path rev-parse HEAD).Trim()
    $Status = git -C $Path status --porcelain

    Assert-Condition ($Actual -eq $Sha) "SHA incorreto em $Name: $Actual"
    Assert-Condition (-not [bool]$Status) "Worktree sujo após checkout: $Path"
}

function Invoke-NpmCiClean {
    param([string]$Path)

    Push-Location $Path
    try {
        & npm.cmd ci --no-audit --no-fund --loglevel=error
        Assert-LastExitCode -Message "npm ci falhou em $Path."

        $Status = git status --porcelain
        Assert-Condition (-not [bool]$Status) "npm ci deixou o worktree sujo: $Path"
    }
    finally {
        Pop-Location
    }
}

function Invoke-Preflight {
    param([bool]$InstallDependencies = $true)

    Write-Host "`n=== PREFLIGHT DA JANELA P0 ==="

    $GitCommand = Get-CommandPath -Names @('git.exe', 'git')
    $NodeCommand = Get-CommandPath -Names @('node.exe', 'node')
    $NpmCommand = Get-CommandPath -Names @('npm.cmd', 'npm')
    $Pm2Command = Get-CommandPath -Names @('pm2.cmd', 'pm2')

    $null = $GitCommand
    $null = $NodeCommand
    $null = $NpmCommand

    $RuntimeSha = Assert-RuntimeRepository

    Set-Location $RuntimeRepo
    git fetch origin --prune
    Assert-LastExitCode -Message 'Falha no git fetch.'

    Ensure-DetachedWorktree -Name 'blank-player-audit' -Path $BlankAuditPath -Sha $BlankAuditSha
    Ensure-DetachedWorktree -Name 'blank-player-cleanup' -Path $CleanupPath -Sha $CleanupSha
    Ensure-DetachedWorktree -Name 'canonical-role-migration' -Path $RoleMigrationPath -Sha $RoleMigrationSha

    if ($InstallDependencies) {
        Invoke-NpmCiClean -Path $BlankAuditPath
        Invoke-NpmCiClean -Path $CleanupPath
        Invoke-NpmCiClean -Path $RoleMigrationPath
    }

    Push-Location $BlankAuditPath
    try {
        node --check scripts\auditBlankPlayerIdentities.js
        Assert-LastExitCode -Message 'Falha sintática no auditor de identidades.'
        node --test tests\auditBlankPlayerIdentitiesContract.test.js
        Assert-LastExitCode -Message 'Contrato do auditor de identidades falhou.'
    }
    finally {
        Pop-Location
    }

    Push-Location $CleanupPath
    try {
        node --check helpers\clover\blankPlayerIdentityCleanupService.js
        Assert-LastExitCode -Message 'Falha sintática no serviço de limpeza.'
        node --check scripts\cleanupBlankPlayerIdentities.js
        Assert-LastExitCode -Message 'Falha sintática no executor de limpeza.'
        node --check helpers\clover\blankPlayerIdentityRestoreService.js
        Assert-LastExitCode -Message 'Falha sintática no serviço de restauração.'
        node --check scripts\restoreBlankPlayerIdentities.js
        Assert-LastExitCode -Message 'Falha sintática no executor de restauração.'
        node --test tests\blankPlayerIdentityCleanupContract.test.js tests\blankPlayerIdentityRestoreContract.test.js
        Assert-LastExitCode -Message 'Contratos de limpeza/restauração falharam.'
    }
    finally {
        Pop-Location
    }

    Push-Location $RoleMigrationPath
    try {
        node --check helpers\clover\canonicalRoleMigrationBatchService.js
        Assert-LastExitCode -Message 'Falha sintática no serviço de migração de cargos.'
        node --check scripts\migrateCanonicalRoles.js
        Assert-LastExitCode -Message 'Falha sintática no executor de migração de cargos.'
        node --check scripts\rollbackCanonicalRoleMigration.js
        Assert-LastExitCode -Message 'Falha sintática no executor de rollback de cargos.'
        node --test `
            tests\canonicalRolePermissionMatrixContract.test.js `
            tests\canonicalRoleGrantContract.test.js `
            tests\canonicalRoleShadowContract.test.js `
            tests\canonicalRoleShadowReadOnlyContract.test.js `
            tests\auditCanonicalRoleShadowContract.test.js `
            tests\canonicalRoleMigrationBatchContract.test.js
        Assert-LastExitCode -Message 'Contratos canônicos de cargos falharam.'
    }
    finally {
        Pop-Location
    }

    $Pm2State = Get-Pm2AppState -Pm2Command $Pm2Command -Name $Pm2App
    Assert-Condition ($Pm2State -eq 'online') "O app $Pm2App deve estar online no preflight; estado atual: $Pm2State"

    $Receipt = [ordered]@{
        version = 'clover.phase0.live-window-preflight.v1'
        generatedAt = [DateTime]::UtcNow.ToString('o')
        runtimeRepo = $RuntimeRepo
        runtimeSha = $RuntimeSha
        liveDatabase = $LiveDatabase
        pm2App = $Pm2App
        pm2State = $Pm2State
        healthUrl = $HealthUrl
        worktrees = [ordered]@{
            blankAudit = [ordered]@{ path = $BlankAuditPath; sha = $BlankAuditSha }
            cleanup = [ordered]@{ path = $CleanupPath; sha = $CleanupSha }
            roleMigration = [ordered]@{ path = $RoleMigrationPath; sha = $RoleMigrationSha }
        }
        expected = [ordered]@{
            blankIdentityCount = $ExpectedBlankIdentityCount
            roleSubjectCount = $ExpectedRoleSubjectCount
            plannedGrantCount = $ExpectedPlannedGrantCount
            legacyAdminCount = $ExpectedLegacyAdminCount
            legacyAccessCount = $ExpectedLegacyAccessCount
        }
        safeToOpenWindow = $true
    }

    New-Item -ItemType Directory -Path $PrivateRoot -Force | Out-Null
    $ReceiptPath = Join-Path $PrivateRoot ("phase0-live-window-preflight-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Write-JsonFileExclusive -Path $ReceiptPath -Value $Receipt

    Write-Host "Preflight aprovado: $ReceiptPath" -ForegroundColor Green
    return [pscustomobject]@{
        Pm2Command = $Pm2Command
        ReceiptPath = $ReceiptPath
        RuntimeSha = $RuntimeSha
    }
}
