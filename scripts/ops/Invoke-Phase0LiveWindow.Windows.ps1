[CmdletBinding()]
param(
    [ValidateSet('Preflight', 'Apply', 'Rollback')]
    [string]$Mode = 'Preflight',

    [string]$RuntimeRepo = 'C:\Users\natan\Documents\meu-bot-rpg',
    [string]$WorktreeBase = 'C:\Users\natan\Documents\clover-phase0-worktrees',
    [string]$PrivateRoot = 'C:\Users\natan\Documents\clover-phase0-private',
    [string]$Pm2App = 'clover-rpg',
    [string]$HealthUrl = 'http://127.0.0.1:8787/health',
    [string]$Actor = 'natan',
    [string]$Reason = 'Janela P0 controlada para conter identidades nulas e migrar cargos canonicos auditados',
    [string]$Confirmation = '',
    [string]$Bundle = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$SourceDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$TemporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("clover-phase0-runbook-{0}" -f ([Guid]::NewGuid().ToString('N')))
$SourceFiles = @(
    'Invoke-Phase0LiveWindow.ps1',
    'Phase0LiveWindow.Common.ps1',
    'Phase0LiveWindow.Sqlite.ps1',
    'Phase0LiveWindow.Runtime.ps1'
)

$Utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
$Utf16LeBom = [System.Text.Encoding]::Unicode

try {
    New-Item -ItemType Directory -Path $TemporaryDirectory -Force | Out-Null

    foreach ($FileName in $SourceFiles) {
        $SourcePath = Join-Path $SourceDirectory $FileName
        $TargetPath = Join-Path $TemporaryDirectory $FileName

        if (-not (Test-Path $SourcePath)) {
            throw "Arquivo do runbook ausente: $SourcePath"
        }

        $Text = [System.IO.File]::ReadAllText($SourcePath, $Utf8Strict)
        [System.IO.File]::WriteAllText($TargetPath, $Text, $Utf16LeBom)
    }

    $EntryPoint = Join-Path $TemporaryDirectory 'Invoke-Phase0LiveWindow.ps1'

    & $EntryPoint `
        -Mode $Mode `
        -RuntimeRepo $RuntimeRepo `
        -WorktreeBase $WorktreeBase `
        -PrivateRoot $PrivateRoot `
        -Pm2App $Pm2App `
        -HealthUrl $HealthUrl `
        -Actor $Actor `
        -Reason $Reason `
        -Confirmation $Confirmation `
        -Bundle $Bundle

    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
finally {
    if (Test-Path $TemporaryDirectory) {
        Remove-Item -Path $TemporaryDirectory -Recurse -Force
    }
}
