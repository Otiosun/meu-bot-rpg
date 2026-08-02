[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TemporaryDirectory = Join-Path $env:TEMP ("clover-preflight-output-contract-{0}" -f [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TemporaryDirectory -Force | Out-Null

try {
    $Utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
    $Utf16LeBom = [System.Text.Encoding]::Unicode

    $CommonSource = Join-Path $RepositoryRoot 'scripts\ops\Phase0LiveWindow.Common.ps1'
    $CommonCopy = Join-Path $TemporaryDirectory 'Phase0LiveWindow.Common.ps1'
    $CommonText = [System.IO.File]::ReadAllText($CommonSource, $Utf8Strict)
    [System.IO.File]::WriteAllText($CommonCopy, $CommonText, $Utf16LeBom)

    . $CommonCopy

    $script:ExpectedRuntimeSha = 'runtime-sha'
    $script:RuntimeRepo = Join-Path $TemporaryDirectory 'runtime'
    $script:LiveDatabase = Join-Path $script:RuntimeRepo 'banco.sqlite'
    $script:BlankAuditPath = Join-Path $TemporaryDirectory 'blank-audit'
    $script:CleanupPath = Join-Path $TemporaryDirectory 'cleanup'
    $script:RoleMigrationPath = Join-Path $TemporaryDirectory 'roles'
    $script:BlankAuditSha = 'blank-sha'
    $script:CleanupSha = 'cleanup-sha'
    $script:RoleMigrationSha = 'role-sha'
    $script:Pm2App = 'clover-rpg'
    $script:HealthUrl = 'http://127.0.0.1:8787/health'
    $script:PrivateRoot = Join-Path $TemporaryDirectory 'private'
    $script:ExpectedBlankIdentityCount = 10
    $script:ExpectedRoleSubjectCount = 15
    $script:ExpectedPlannedGrantCount = 18
    $script:ExpectedLegacyAdminCount = 5
    $script:ExpectedLegacyAccessCount = 14

    foreach ($Path in @(
        $script:RuntimeRepo,
        $script:BlankAuditPath,
        $script:CleanupPath,
        $script:RoleMigrationPath,
        $script:PrivateRoot
    )) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }

    [System.IO.File]::WriteAllText($script:LiveDatabase, 'fixture')

    function Get-CommandPath {
        param([string[]]$Names)
        return [string]$Names[0]
    }

    function Assert-RuntimeRepository {
        return 'runtime-sha'
    }

    function git {
        Write-Output 'git diagnostic that must not enter the return pipeline'
        $global:LASTEXITCODE = 0
    }

    function Ensure-DetachedWorktree {
        param(
            [string]$Name,
            [string]$Path,
            [string]$Sha
        )
        Write-Output "worktree diagnostic: $Name"
        $global:LASTEXITCODE = 0
    }

    function Invoke-NpmCiClean {
        param([string]$Path)
        Write-Output "npm diagnostic: $Path"
        $global:LASTEXITCODE = 0
    }

    function node {
        Write-Output 'node diagnostic that must not enter the return pipeline'
        $global:LASTEXITCODE = 0
    }

    function Get-Pm2AppState {
        param(
            [string]$Pm2Command,
            [string]$Name,
            [string]$NodeCommand = ''
        )
        return 'online'
    }

    $Output = @(Invoke-Preflight -InstallDependencies $true)

    if ($Output.Count -ne 1) {
        throw "Invoke-Preflight deveria retornar exatamente um objeto, mas retornou $($Output.Count)."
    }

    $Result = $Output[0]

    foreach ($Property in @('Pm2Command', 'ReceiptPath', 'RuntimeSha')) {
        if (-not $Result.PSObject.Properties[$Property]) {
            throw "Propriedade ausente no resultado do preflight: $Property"
        }
    }

    if ($Result.RuntimeSha -ne 'runtime-sha') {
        throw "RuntimeSha inesperado: $($Result.RuntimeSha)"
    }

    if (-not (Test-Path $Result.ReceiptPath)) {
        throw "Recibo do preflight não foi criado: $($Result.ReceiptPath)"
    }

    Write-Host 'Preflight single-result contract passed.' -ForegroundColor Green
}
finally {
    Remove-Item -Path $TemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
