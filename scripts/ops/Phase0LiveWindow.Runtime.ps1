function Stop-CloverRuntime {
    param([string]$Pm2Command)

    & $Pm2Command stop $Pm2App
    Assert-LastExitCode -Message "Falha ao parar $Pm2App."
    $null = Wait-Pm2State -Pm2Command $Pm2Command -Name $Pm2App -AllowedStates @('stopped')
}

function Start-CloverRuntime {
    param([string]$Pm2Command)

    & $Pm2Command start $Pm2App
    Assert-LastExitCode -Message "Falha ao iniciar $Pm2App."
    $null = Wait-Pm2State -Pm2Command $Pm2Command -Name $Pm2App -AllowedStates @('online')

    Assert-Condition (Test-HealthEndpoint -Url $HealthUrl) "Health check falhou: $HealthUrl"
}

function Restore-Baseline {
    param(
        [string]$Pm2Command,
        [string]$BaselineDatabase,
        [string]$ExpectedHash,
        [string]$FailureReceipt
    )

    Write-Host "`n=== ROLLBACK DE EMERGÊNCIA PARA O BASELINE ===" -ForegroundColor Yellow

    try {
        $State = Get-Pm2AppState -Pm2Command $Pm2Command -Name $Pm2App
        if ($State -eq 'online') {
            Stop-CloverRuntime -Pm2Command $Pm2Command
        }

        foreach ($Auxiliary in @("$LiveDatabase-wal", "$LiveDatabase-shm")) {
            if (Test-Path $Auxiliary) {
                Remove-Item -Path $Auxiliary -Force
            }
        }

        if (Test-Path $LiveDatabase) {
            Remove-Item -Path $LiveDatabase -Force
        }

        Copy-Item -Path $BaselineDatabase -Destination $LiveDatabase
        $RestoredHash = Get-Sha256 $LiveDatabase
        Assert-Condition ($RestoredHash -eq $ExpectedHash) 'O banco restaurado não corresponde ao baseline.'

        Start-CloverRuntime -Pm2Command $Pm2Command

        Write-JsonFileExclusive -Path $FailureReceipt -Value ([ordered]@{
            version = 'clover.phase0.live-window-emergency-rollback.v1'
            restoredAt = [DateTime]::UtcNow.ToString('o')
            baselineDatabase = $BaselineDatabase
            baselineSha256 = $ExpectedHash
            liveDatabase = $LiveDatabase
            restoredSha256 = $RestoredHash
            pm2App = $Pm2App
            pm2State = 'online'
            healthUrl = $HealthUrl
            healthOk = $true
        })

        Write-Host "Baseline restaurado e runtime reativado." -ForegroundColor Green
    }
    catch {
        Write-Host "FALHA CRÍTICA NO ROLLBACK AUTOMÁTICO: $($_.Exception.Message)" -ForegroundColor Red
        throw
    }
}
