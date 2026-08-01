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
    [string]$Reason = 'Janela P0 controlada para conter identidades nulas e migrar cargos canônicos auditados',
    [string]$Confirmation = '',
    [string]$Bundle = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ExpectedRuntimeSha = '60b1af1685dd83ef8f234f030da914d98b5a2379'
$BlankAuditSha = '2d303c832cb60c6c7b6a95901e30b1ab0d6722b3'
$CleanupSha = '34ecd2f40281c7e77d43d8fc9a1801b9292dfdd4'
$RoleMigrationSha = '1a4985de75686ce7748e4ef893dd1cc6f9978565'

$ExpectedBlankIdentityCount = 10
$ExpectedRoleSubjectCount = 15
$ExpectedPlannedGrantCount = 18
$ExpectedLegacyAdminCount = 5
$ExpectedLegacyAccessCount = 14

$LiveDatabase = Join-Path $RuntimeRepo 'banco.sqlite'
$BlankAuditPath = Join-Path $WorktreeBase 'blank-player-audit'
$CleanupPath = Join-Path $WorktreeBase 'blank-player-cleanup'
$RoleMigrationPath = Join-Path $WorktreeBase 'canonical-role-migration'

$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $ScriptDirectory 'Phase0LiveWindow.Common.ps1')
. (Join-Path $ScriptDirectory 'Phase0LiveWindow.Sqlite.ps1')
. (Join-Path $ScriptDirectory 'Phase0LiveWindow.Runtime.ps1')

function Invoke-ApplyWindow {
    Assert-Condition ($Confirmation -eq 'APLICAR-P0-AO-VIVO') 'Confirmação inválida. Use -Confirmation APLICAR-P0-AO-VIVO.'
    Assert-Condition (-not [string]::IsNullOrWhiteSpace($Actor)) 'Actor obrigatório.'
    Assert-Condition ($Reason.Trim().Length -ge 20) 'Reason deve ter pelo menos 20 caracteres.'

    $Preflight = Invoke-Preflight -InstallDependencies $true
    $Pm2Command = $Preflight.Pm2Command

    $Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $WindowDir = Join-Path $PrivateRoot "phase0-live-window-$Timestamp"
    New-Item -ItemType Directory -Path $WindowDir -Force | Out-Null

    $Transcript = Join-Path $WindowDir 'window-transcript.txt'
    Start-Transcript -Path $Transcript | Out-Null

    $BaselineDatabase = Join-Path $WindowDir 'baseline-live.sqlite'
    $BaselineHashFile = Join-Path $WindowDir 'baseline-sha256.txt'
    $MaintenanceReport = Join-Path $WindowDir 'baseline-maintenance.json'
    $BlankAuditReport = Join-Path $WindowDir 'blank-identities-audit.json'
    $CleanupDryRun = Join-Path $WindowDir 'blank-cleanup-dry-run.json'
    $CleanupBackup = Join-Path $WindowDir 'before-blank-cleanup.sqlite'
    $CleanupReceipt = Join-Path $WindowDir 'blank-cleanup-apply.json'
    $RoleShadowReport = Join-Path $WindowDir 'role-shadow-before-migration.json'
    $RoleDryRun = Join-Path $WindowDir 'role-migration-dry-run.json'
    $RoleBackup = Join-Path $WindowDir 'before-role-migration.sqlite'
    $RoleReceipt = Join-Path $WindowDir 'role-migration-apply.json'
    $PostRoleShadow = Join-Path $WindowDir 'role-shadow-after-migration.json'
    $FinalVerificationPath = Join-Path $WindowDir 'final-verification.json'
    $ManifestPath = Join-Path $WindowDir 'window-manifest.json'
    $FailureRollbackReceipt = Join-Path $WindowDir 'emergency-rollback.json'

    $BaselineHash = $null
    $WindowSucceeded = $false

    try {
        Write-Host "`n=== CONGELANDO APENAS $Pm2App ==="
        Stop-CloverRuntime -Pm2Command $Pm2Command

        Invoke-SqliteMaintenance -Database $LiveDatabase -OutputPath $MaintenanceReport | Out-Null

        foreach ($Auxiliary in @("$LiveDatabase-wal", "$LiveDatabase-shm")) {
            if (Test-Path $Auxiliary) {
                Remove-Item -Path $Auxiliary -Force
            }
        }

        $BaselineHash = Get-Sha256 $LiveDatabase
        Copy-Item -Path $LiveDatabase -Destination $BaselineDatabase
        Assert-Condition ((Get-Sha256 $BaselineDatabase) -eq $BaselineHash) 'O backup baseline não é byte a byte idêntico.'
        Set-Content -Path $BaselineHashFile -Value $BaselineHash -Encoding ascii

        Write-Host "Baseline congelado: $BaselineHash"

        Write-Host "`n=== AUDITORIA NOVA DOS PLACEHOLDERS NO BANCO CONGELADO ==="
        Push-Location $BlankAuditPath
        try {
            node scripts\auditBlankPlayerIdentities.js `
                "--db=$LiveDatabase" `
                "--expected-auditor-sha=$BlankAuditSha" `
                "--output=$BlankAuditReport" `
                --fail-on-unsafe
            $BlankAuditExit = $LASTEXITCODE
        }
        finally {
            Pop-Location
        }
        Assert-Condition (@(0, 2) -contains $BlankAuditExit) "Auditoria dos placeholders falhou: $BlankAuditExit"

        $BlankAudit = Get-Content $BlankAuditReport -Raw | ConvertFrom-Json
        $BlankSummary = $BlankAudit.result.summary
        $BlankAuditChecks = @(
            ($BlankAudit.write -eq $false)
            ($BlankAudit.queryOnlySafe -eq $true)
            ($BlankAudit.database.unchanged -eq $true)
            ([string]$BlankAudit.database.sha256 -eq $BaselineHash)
            ([int]$BlankSummary.blankIdentityCount -eq $ExpectedBlankIdentityCount)
            ([int]$BlankSummary.exactPlaceholderCount -eq $ExpectedBlankIdentityCount)
            ([int]$BlankSummary.dataBearingCount -eq 0)
            ([int]$BlankSummary.signatureMismatchCount -eq 0)
            ([int]$BlankSummary.foreignKeyDefinitionCount -eq 0)
            ([int]$BlankSummary.explicitRowidReferenceCount -eq 0)
            ([int]$BlankSummary.externalNameReferenceCount -eq 0)
            ($BlankSummary.reviewRequired -eq $true)
        )
        Assert-Condition (-not ($BlankAuditChecks -contains $false)) 'A evidência viva dos placeholders divergiu do cenário aprovado.'

        Write-Host "`n=== DRY-RUN E APPLY DA LIMPEZA ==="
        Push-Location $CleanupPath
        try {
            node scripts\cleanupBlankPlayerIdentities.js `
                "--db=$LiveDatabase" `
                "--audit-report=$BlankAuditReport" `
                "--expected-runner-sha=$CleanupSha" `
                "--expected-db-sha256=$BaselineHash" `
                "--output=$CleanupDryRun"
            Assert-LastExitCode -Message 'Dry-run da limpeza falhou.'

            $CleanupPlan = Get-Content $CleanupDryRun -Raw | ConvertFrom-Json
            Assert-Condition ($CleanupPlan.write -eq $false) 'Dry-run da limpeza declarou escrita.'
            Assert-Condition ($CleanupPlan.plan.safe -eq $true) 'Dry-run da limpeza não foi seguro.'
            Assert-Condition ([int]$CleanupPlan.plan.rowCount -eq $ExpectedBlankIdentityCount) 'Quantidade inesperada no dry-run da limpeza.'
            Assert-Condition ($CleanupPlan.database.unchanged -eq $true) 'Banco mudou no dry-run da limpeza.'

            node scripts\cleanupBlankPlayerIdentities.js `
                "--db=$LiveDatabase" `
                "--audit-report=$BlankAuditReport" `
                "--expected-runner-sha=$CleanupSha" `
                "--expected-db-sha256=$BaselineHash" `
                "--backup=$CleanupBackup" `
                "--actor=$Actor" `
                "--reason=$Reason" `
                "--output=$CleanupReceipt" `
                --apply
            Assert-LastExitCode -Message 'Apply da limpeza falhou.'
        }
        finally {
            Pop-Location
        }

        $Cleanup = Get-Content $CleanupReceipt -Raw | ConvertFrom-Json
        $AfterCleanupHash = Get-Sha256 $LiveDatabase
        Assert-Condition ([string]$Cleanup.database.sha256After -eq $AfterCleanupHash) 'Hash pós-limpeza divergente.'
        Assert-Condition ([int]$Cleanup.applied.archivedCount -eq $ExpectedBlankIdentityCount) 'Arquivo da limpeza incompleto.'
        Assert-Condition ([int]$Cleanup.applied.deletedCount -eq $ExpectedBlankIdentityCount) 'Remoção da limpeza incompleta.'
        Assert-Condition ((Get-Sha256 $CleanupBackup) -eq $BaselineHash) 'Backup interno da limpeza divergente.'

        Write-Host "`n=== ROLE SHADOW NOVO APÓS A CONTENÇÃO ==="
        $ReferenceDate = [DateTime]::UtcNow.ToString('o')
        Push-Location $RoleMigrationPath
        try {
            node scripts\auditCanonicalRoleShadow.js `
                "--db=$LiveDatabase" `
                "--expected-auditor-sha=$RoleMigrationSha" `
                "--reference-date=$ReferenceDate" `
                "--output=$RoleShadowReport" `
                --fail-on-critical
            Assert-LastExitCode -Message 'Role shadow vivo encontrou críticos.'
        }
        finally {
            Pop-Location
        }

        $RoleShadow = Get-Content $RoleShadowReport -Raw | ConvertFrom-Json
        $RoleShadowChecks = @(
            ($RoleShadow.write -eq $false)
            ($RoleShadow.queryOnlySafe -eq $true)
            ($RoleShadow.database.unchanged -eq $true)
            ([string]$RoleShadow.database.sha256 -eq $AfterCleanupHash)
            ([int]$RoleShadow.result.subjectCount -eq $ExpectedRoleSubjectCount)
            ([int]$RoleShadow.result.criticalCount -eq 0)
            ([int]$RoleShadow.result.unapprovedCanonicalExpansionCount -eq 0)
            ([int]$RoleShadow.result.unapprovedCanonicalRegressionCount -eq 0)
            ([int]$RoleShadow.result.scopeLeakCount -eq 0)
        )
        Assert-Condition (-not ($RoleShadowChecks -contains $false)) 'O role shadow vivo divergiu da política aprovada.'

        Write-Host "`n=== DRY-RUN E APPLY DA MIGRAÇÃO DE CARGOS ==="
        Push-Location $RoleMigrationPath
        try {
            node scripts\migrateCanonicalRoles.js `
                "--db=$LiveDatabase" `
                "--shadow-report=$RoleShadowReport" `
                "--expected-runner-sha=$RoleMigrationSha" `
                "--expected-db-sha256=$AfterCleanupHash" `
                "--output=$RoleDryRun"
            Assert-LastExitCode -Message 'Dry-run da migração de cargos falhou.'

            $RolePlan = Get-Content $RoleDryRun -Raw | ConvertFrom-Json
            $RolePlanChecks = @(
                ($RolePlan.write -eq $false)
                ($RolePlan.plan.safe -eq $true)
                ([int]$RolePlan.plan.plannedCount -eq $ExpectedPlannedGrantCount)
                ([int]$RolePlan.plan.canonicalActiveCount -eq 0)
                ([int]$RolePlan.plan.legacyAdminCount -eq $ExpectedLegacyAdminCount)
                ([int]$RolePlan.plan.legacyAccessCount -eq $ExpectedLegacyAccessCount)
                ($RolePlan.database.unchanged -eq $true)
            )
            Assert-Condition (-not ($RolePlanChecks -contains $false)) 'O plano vivo de cargos divergiu da evidência aprovada.'

            node scripts\migrateCanonicalRoles.js `
                "--db=$LiveDatabase" `
                "--shadow-report=$RoleShadowReport" `
                "--expected-runner-sha=$RoleMigrationSha" `
                "--expected-db-sha256=$AfterCleanupHash" `
                "--backup=$RoleBackup" `
                "--actor=$Actor" `
                "--reason=$Reason" `
                "--output=$RoleReceipt" `
                --apply
            Assert-LastExitCode -Message 'Apply da migração de cargos falhou.'
        }
        finally {
            Pop-Location
        }

        $RoleMigration = Get-Content $RoleReceipt -Raw | ConvertFrom-Json
        $FinalHash = Get-Sha256 $LiveDatabase
        $BatchId = [int]$RoleMigration.applied.batchId
        Assert-Condition ([string]$RoleMigration.database.sha256After -eq $FinalHash) 'Hash pós-migração divergente.'
        Assert-Condition ([int]$RoleMigration.applied.insertedCount -eq $ExpectedPlannedGrantCount) 'Quantidade de grants inseridos divergente.'
        Assert-Condition ($BatchId -gt 0) 'Lote canônico inválido.'
        Assert-Condition ((Get-Sha256 $RoleBackup) -eq $AfterCleanupHash) 'Backup interno da migração divergente.'

        Write-Host "`n=== SHADOW E VERIFICAÇÃO FINAL ==="
        Push-Location $RoleMigrationPath
        try {
            node scripts\auditCanonicalRoleShadow.js `
                "--db=$LiveDatabase" `
                "--expected-auditor-sha=$RoleMigrationSha" `
                "--reference-date=$ReferenceDate" `
                "--output=$PostRoleShadow" `
                --fail-on-critical
            Assert-LastExitCode -Message 'Role shadow pós-migração encontrou críticos.'
        }
        finally {
            Pop-Location
        }

        $PostShadow = Get-Content $PostRoleShadow -Raw | ConvertFrom-Json
        Assert-Condition ([int]$PostShadow.result.criticalCount -eq 0) 'Crítico no shadow pós-migração.'
        Assert-Condition ([int]$PostShadow.result.unapprovedCanonicalExpansionCount -eq 0) 'Expansão indevida pós-migração.'
        Assert-Condition ([int]$PostShadow.result.unapprovedCanonicalRegressionCount -eq 0) 'Regressão indevida pós-migração.'
        Assert-Condition ([int]$PostShadow.result.scopeLeakCount -eq 0) 'Vazamento de escopo pós-migração.'

        $FinalVerification = Invoke-LiveVerification -Database $LiveDatabase -OutputPath $FinalVerificationPath -ExpectedBatchId $BatchId
        $FinalChecks = @(
            ([int]$FinalVerification.blankIdentityCount -eq 0)
            ([int]$FinalVerification.archiveCount -eq $ExpectedBlankIdentityCount)
            ([int]$FinalVerification.triggerCount -eq 2)
            ($FinalVerification.batchStatus -eq 'applied')
            ([int]$FinalVerification.mappedCount -eq $ExpectedPlannedGrantCount)
            ([int]$FinalVerification.activeMappedCount -eq $ExpectedPlannedGrantCount)
            ([int]$FinalVerification.activeCanonicalCount -eq $ExpectedPlannedGrantCount)
            ([int]$FinalVerification.grantedEventCount -eq $ExpectedPlannedGrantCount)
            ([int]$FinalVerification.legacyAdminCount -eq $ExpectedLegacyAdminCount)
            ([int]$FinalVerification.legacyAccessCount -eq $ExpectedLegacyAccessCount)
            ($FinalVerification.integrityOk -eq $true)
        )
        Assert-Condition (-not ($FinalChecks -contains $false)) 'A verificação final do banco vivo falhou.'

        Write-Host "`n=== REATIVANDO O RUNTIME ==="
        Start-CloverRuntime -Pm2Command $Pm2Command

        $Manifest = [ordered]@{
            version = 'clover.phase0.live-window.v1'
            status = 'applied'
            startedAt = (Get-Item $Transcript).CreationTimeUtc.ToString('o')
            completedAt = [DateTime]::UtcNow.ToString('o')
            actor = $Actor
            reason = $Reason
            runtime = [ordered]@{
                repo = $RuntimeRepo
                sha = $ExpectedRuntimeSha
                pm2App = $Pm2App
                state = 'online'
                healthUrl = $HealthUrl
                healthOk = $true
            }
            database = [ordered]@{
                path = $LiveDatabase
                baselineSha256 = $BaselineHash
                afterCleanupSha256 = $AfterCleanupHash
                finalSha256 = $FinalHash
                baselineBackup = $BaselineDatabase
                cleanupBackup = $CleanupBackup
                roleMigrationBackup = $RoleBackup
            }
            cleanup = [ordered]@{
                audit = $BlankAuditReport
                dryRun = $CleanupDryRun
                receipt = $CleanupReceipt
                archived = $ExpectedBlankIdentityCount
                deleted = $ExpectedBlankIdentityCount
            }
            roles = [ordered]@{
                referenceDate = $ReferenceDate
                shadowBefore = $RoleShadowReport
                dryRun = $RoleDryRun
                receipt = $RoleReceipt
                batchId = $BatchId
                inserted = $ExpectedPlannedGrantCount
                shadowAfter = $PostRoleShadow
            }
            verification = $FinalVerificationPath
            transcript = $Transcript
        }
        Write-JsonFileExclusive -Path $ManifestPath -Value $Manifest

        $WindowSucceeded = $true
        Write-Host "`nJANELA P0 APLICADA E VALIDADA." -ForegroundColor Green
        Write-Host "Manifesto: $ManifestPath" -ForegroundColor Green
        Write-Host "Backup baseline: $BaselineDatabase" -ForegroundColor Green
    }
    catch {
        $OriginalError = $_
        Write-Host "`nA JANELA FALHOU: $($OriginalError.Exception.Message)" -ForegroundColor Red

        if ($BaselineHash -and (Test-Path $BaselineDatabase)) {
            Restore-Baseline `
                -Pm2Command $Pm2Command `
                -BaselineDatabase $BaselineDatabase `
                -ExpectedHash $BaselineHash `
                -FailureReceipt $FailureRollbackReceipt
        }
        else {
            $State = Get-Pm2AppState -Pm2Command $Pm2Command -Name $Pm2App
            if ($State -ne 'online') {
                Start-CloverRuntime -Pm2Command $Pm2Command
            }
        }

        throw $OriginalError
    }
    finally {
        try {
            Stop-Transcript | Out-Null
        }
        catch {
            # O transcript pode não ter sido iniciado completamente.
        }

        if (-not $WindowSucceeded) {
            Write-Host "Banco vivo devolvido ao baseline quando disponível." -ForegroundColor Yellow
        }
    }
}

function Invoke-ManualRollback {
    Assert-Condition ($Confirmation -eq 'RESTAURAR-BASELINE-P0') 'Confirmação inválida. Use -Confirmation RESTAURAR-BASELINE-P0.'
    Assert-Condition (-not [string]::IsNullOrWhiteSpace($Bundle)) 'Informe -Bundle com a pasta da janela.'
    Assert-Condition (Test-Path $Bundle) "Bundle ausente: $Bundle"

    $Pm2Command = Get-CommandPath -Names @('pm2.cmd', 'pm2')
    $BaselineDatabase = Join-Path $Bundle 'baseline-live.sqlite'
    $BaselineHashFile = Join-Path $Bundle 'baseline-sha256.txt'
    $RollbackReceipt = Join-Path $Bundle ("manual-baseline-rollback-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

    Assert-Condition (Test-Path $BaselineDatabase) "Backup baseline ausente: $BaselineDatabase"
    Assert-Condition (Test-Path $BaselineHashFile) "Hash baseline ausente: $BaselineHashFile"

    $ExpectedHash = (Get-Content $BaselineHashFile -Raw).Trim().ToLowerInvariant()
    Assert-Condition ((Get-Sha256 $BaselineDatabase) -eq $ExpectedHash) 'O backup baseline não corresponde ao hash registrado.'

    Restore-Baseline `
        -Pm2Command $Pm2Command `
        -BaselineDatabase $BaselineDatabase `
        -ExpectedHash $ExpectedHash `
        -FailureReceipt $RollbackReceipt

    Write-Host "Rollback manual concluído: $RollbackReceipt" -ForegroundColor Green
}

switch ($Mode) {
    'Preflight' {
        $null = Invoke-Preflight -InstallDependencies $true
    }
    'Apply' {
        Invoke-ApplyWindow
    }
    'Rollback' {
        Invoke-ManualRollback
    }
}
