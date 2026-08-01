[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TemporaryDirectory = Join-Path $env:TEMP ("clover-pm2-contract-{0}" -f [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TemporaryDirectory -Force | Out-Null

try {
    $Utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
    $Utf16LeBom = [System.Text.Encoding]::Unicode
    $Ascii = [System.Text.Encoding]::ASCII

    $CommonSource = Join-Path $RepositoryRoot 'scripts\ops\Phase0LiveWindow.Common.ps1'
    $CommonCopy = Join-Path $TemporaryDirectory 'Phase0LiveWindow.Common.ps1'
    $CommonText = [System.IO.File]::ReadAllText($CommonSource, $Utf8Strict)
    [System.IO.File]::WriteAllText($CommonCopy, $CommonText, $Utf16LeBom)

    . $CommonCopy

    $FixturePath = Join-Path $TemporaryDirectory 'pm2-jlist.json'
    $FixtureJson = '[{"name":"clover-rpg","pm2_env":{"status":"online","env":{"PATH":"C:\\Tools","Path":"C:\\Windows"}}}]'
    [System.IO.File]::WriteAllText($FixturePath, $FixtureJson, $Ascii)

    $FakePm2 = Join-Path $TemporaryDirectory 'fake-pm2.cmd'
    $FakePm2Content = @"
@echo off
if /I "%~1"=="jlist" (
  type "$FixturePath"
  exit /b 0
)
exit /b 3
"@
    [System.IO.File]::WriteAllText($FakePm2, $FakePm2Content, $Ascii)

    $NodeCommand = (Get-Command node.exe -ErrorAction Stop).Source

    $State = Get-Pm2AppState `
        -Pm2Command $FakePm2 `
        -Name 'clover-rpg' `
        -NodeCommand $NodeCommand

    if ($State -ne 'online') {
        throw "Estado inesperado: $State"
    }

    $MissingState = Get-Pm2AppState `
        -Pm2Command $FakePm2 `
        -Name 'missing-app' `
        -NodeCommand $NodeCommand

    if ($null -ne $MissingState) {
        throw "App ausente deveria retornar null, mas retornou: $MissingState"
    }

    Write-Host 'PM2 duplicate-case JSON contract passed.' -ForegroundColor Green
}
finally {
    Remove-Item -Path $TemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
