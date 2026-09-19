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
        [string]$Name,
        [string]$NodeCommand = ''
    )

    $Raw = & $Pm2Command jlist 2>$null | Out-String
    Assert-LastExitCode -Message 'Falha ao consultar o PM2.'
    Assert-Condition (-not [string]::IsNullOrWhiteSpace($Raw)) 'O PM2 retornou uma lista JSON vazia.'

    if ([string]::IsNullOrWhiteSpace($NodeCommand)) {
        $NodeCommand = Get-CommandPath -Names @('node.exe', 'node')
    }

    $Parser = @'
const fs = require('fs');
const filePath = process.argv[1];
const name = process.argv[2];
try {
  const input = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const processes = JSON.parse(input);
  const match = Array.isArray(processes)
    ? processes.find((process) => process && process.name === name)
    : null;
  const status = match && match.pm2_env
    ? String(match.pm2_env.status || '')
    : '';
  process.stdout.write(status);
} catch (error) {
  console.error(`invalid_pm2_json: ${error.message}`);
  process.exit(2);
}
'@

    $TemporaryJson = Join-Path $env:TEMP ("clover-pm2-jlist-{0}.json" -f [Guid]::NewGuid().ToString('N'))
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

    try {
        [System.IO.File]::WriteAllText($TemporaryJson, $Raw, $Utf8NoBom)
        $StateOutput = & $NodeCommand -e $Parser $TemporaryJson $Name 2>$null
        Assert-LastExitCode -Message 'Falha ao interpretar a saída JSON do PM2.'
    }
    finally {
        Remove-Item -Path $TemporaryJson -Force -ErrorAction SilentlyContinue
    }

    $State = ($StateOutput | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($State)) {
        return $null
    }

    return $State
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

    throw "O PM2 não alcançou o estado esperado para ${Name}: $($AllowedStates -join ', ')"
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

    Assert-Condition ($Actual -eq $Sha) "SHA incorreto em ${Name}: $Actual"
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
    git fetch origin --prune | Out-Host
    Assert-LastExitCode -Message 'Falha no git fetch.'

    Ensure-DetachedWorktree -Name 'blank-player-audit' -Path $BlankAuditPath -Sha $BlankAuditSha | Out-Host
    Ensure-DetachedWorktree -Name 'blank-player-cleanup' -Path $CleanupPath -Sha $CleanupSha | Out-Host
    Ensure-DetachedWorktree -Name 'canonical-role-migration' -Path $RoleMigrationPath -Sha $RoleMigrationSha | Out-Host

    if ($InstallDependencies) {
        Invoke-NpmCiClean -Path $BlankAuditPath | Out-Host
        Invoke-NpmCiClean -Path $CleanupPath | Out-Host
        Invoke-NpmCiClean -Path $RoleMigrationPath | Out-Host
    }

    Push-Location $BlankAuditPath
    try {
        node --check scripts\auditBlankPlayerIdentities.js | Out-Host
        Assert-LastExitCode -Message 'Falha sintática no auditor de identidades.'
        node --test tests\auditBlankPlayerIdentitiesContract.test.js | Out-Host
        Assert-LastExitCode -Message 'Contrato do auditor de identidades falhou.'
    }
    finally {
        Pop-Location
    }

    Push-Location $CleanupPath
    try {
        node --check helpers\clover\blankPlayerIdentityCleanupService.js | Out-Host
        Assert-LastExitCode -Message 'Falha sintática no serviço de limpeza.'
        node --check scripts\cleanupBlankPlayerIdentities.js | Out-Host
        Assert-LastExitCode -Message 'Falha sintática no executor de limpeza.'
        node --check helpers\clover\blankPlayerIdentityRestoreService.js | Out-Host
        Assert-LastExitCode -Message 'Falha sintática no serviço de restauração.'
        node --check scripts\restoreBlankPlayerIdentities.js | Out-Host
        Assert-LastExitCode -Message 'Falha sintática no executor de restauração.'
        node --test tests\blankPlayerIdentityCleanupContract.test.js tests\blankPlayerIdentityRestoreContract.test.js | Out-Host
        Assert-LastExitCode -Message 'Contratos de limpeza/restauração falharam.'
    }
    finally {
        Pop-Location
    }

    Push-Location $RoleMigrationPath
    try {
        node --check helpers\clover\canonicalRoleMigrationBatchService.js | Out-Host
        Assert-LastExitCode -Message 'Falha sintática no serviço de migração de cargos.'
        node --check scripts\migrateCanonicalRoles.js | Out-Host
        Assert-LastExitCode -Message 'Falha sintática no executor da migração de cargos.'
        node --check scripts\rollbackCanonicalRoleMigration.js | Out-Host
        Assert-LastExitCode -Message 'Falha sintática no executor de rollback de cargos.'
        node --test `
            tests\canonicalRolePermissionMatrixContract.test.js `
            tests\canonicalRoleGrantContract.test.js `
            tests\canonicalRoleShadowContract.test.js `
            tests\canonicalRoleShadowReadOnlyContract.test.js `
            tests\auditCanonicalRoleShadowContract.test.js `
            tests\canonicalRoleMigrationBatchContract.test.js | Out-Host
        Assert-LastExitCode -Message 'Contratos canônicos de cargos falharam.'
    }
    finally {
        Pop-Location
    }

    $Pm2State = Get-Pm2AppState -Pm2Command $Pm2Command -Name $Pm2App -NodeCommand $NodeCommand
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
