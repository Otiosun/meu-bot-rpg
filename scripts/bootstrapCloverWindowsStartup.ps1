param(
    [switch] $InstallTask,
    [switch] $StartClover,
    [string] $TaskName = "CloverRpgPm2Resurrect"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$pm2 = (Get-Command pm2.cmd -ErrorAction SilentlyContinue)

if (-not $pm2) {
    throw "pm2.cmd nao encontrado no PATH."
}

Write-Host "[clover-startup] Repo: $repo"
Write-Host "[clover-startup] PM2: $($pm2.Source)"
Write-Host "[clover-startup] Diagnostico somente leitura:"
node (Join-Path $PSScriptRoot "diagnoseCloverRuntime.js")

if ($StartClover) {
    Write-Host "[clover-startup] Iniciando/atualizando apenas clover-rpg pelo ecosystem local."
    pm2 start (Join-Path $repo "ecosystem.clover.config.cjs") --only clover-rpg --update-env
    pm2 save
}

if ($InstallTask) {
    $action = New-ScheduledTaskAction -Execute $pm2.Source -Argument "resurrect"
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel LeastPrivilege
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
    Write-Host "[clover-startup] Scheduled Task instalada: $TaskName"
}

if (-not $StartClover -and -not $InstallTask) {
    Write-Host "[clover-startup] Nenhuma alteracao feita. Use -StartClover e/ou -InstallTask em janela autorizada."
}
