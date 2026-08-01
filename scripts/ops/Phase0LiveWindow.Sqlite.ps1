function Invoke-SqliteMaintenance {
    param(
        [string]$Database,
        [string]$OutputPath
    )

    $Code = @'
'use strict';

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const databasePath = process.argv[2];
const outputPath = process.argv[3];

if (!databasePath || !outputPath) {
    throw new Error('Informe banco e saída.');
}

if (fs.existsSync(outputPath)) {
    throw new Error(`Saída já existe: ${outputPath}`);
}

const db = new DatabaseSync(databasePath);

try {
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all();
    const integrityRows = db.prepare('PRAGMA integrity_check').all();
    const integrityValues = integrityRows.map((row) => Object.values(row)[0]);
    const result = {
        version: 'clover.phase0.sqlite-maintenance.v1',
        checkpoint,
        integrityValues,
        integrityOk: integrityValues.length === 1 && integrityValues[0] === 'ok',
        completedAt: new Date().toISOString(),
    };
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
    });
    console.log(JSON.stringify(result, null, 2));
} finally {
    db.close();
}
'@

    $ScriptPath = [System.IO.Path]::ChangeExtension($OutputPath, '.cjs')
    $Encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($ScriptPath, $Code, $Encoding)

    node $ScriptPath $Database $OutputPath
    Assert-LastExitCode -Message 'Falha na manutenção SQLite.'

    $Result = Get-Content $OutputPath -Raw | ConvertFrom-Json
    Assert-Condition ($Result.integrityOk -eq $true) 'PRAGMA integrity_check falhou.'
    return $Result
}

function Invoke-LiveVerification {
    param(
        [string]$Database,
        [string]$OutputPath,
        [int]$ExpectedBatchId
    )

    $Code = @'
'use strict';

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const databasePath = process.argv[2];
const outputPath = process.argv[3];
const batchId = Number(process.argv[4]);

if (!databasePath || !outputPath || !Number.isInteger(batchId) || batchId <= 0) {
    throw new Error('Informe banco, saída e lote.');
}

if (fs.existsSync(outputPath)) {
    throw new Error(`Saída já existe: ${outputPath}`);
}

const db = new DatabaseSync(databasePath);

try {
    const blank = db.prepare(`
        SELECT COUNT(*) AS total
        FROM jogadores
        WHERE id IS NULL OR TRIM(CAST(id AS TEXT)) = ''
    `).get();

    const archive = db.prepare(`
        SELECT COUNT(*) AS total
        FROM clover_blank_player_identity_archive
    `).get();

    const triggers = db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'trigger'
          AND name IN (
              'trg_jogadores_require_nonblank_id_insert',
              'trg_jogadores_require_nonblank_id_update'
          )
        ORDER BY name
    `).all();

    const batch = db.prepare(`
        SELECT *
        FROM clover_role_migration_batches
        WHERE id = ?
    `).get(batchId);

    const mapped = db.prepare(`
        SELECT g.status
        FROM clover_role_migration_batch_grants bg
        JOIN clover_role_grants g ON g.id = bg.grant_id
        WHERE bg.batch_id = ?
    `).all(batchId);

    const activeCanonical = db.prepare(`
        SELECT COUNT(*) AS total
        FROM clover_role_grants
        WHERE status = 'active'
    `).get();

    const grantedEvents = db.prepare(`
        SELECT COUNT(*) AS total
        FROM clover_role_grant_events e
        JOIN clover_role_migration_batch_grants bg ON bg.grant_id = e.grant_id
        WHERE bg.batch_id = ? AND e.action = 'granted'
    `).get(batchId);

    const legacyAdmin = db.prepare(`
        SELECT COUNT(*) AS total
        FROM clover_admin_roles
        WHERE active = 1
    `).get();

    const legacyAccess = db.prepare(`
        SELECT COUNT(*) AS total
        FROM clover_access_roles
        WHERE status = 'active'
    `).get();

    const integrityRows = db.prepare('PRAGMA integrity_check').all();
    const integrityValues = integrityRows.map((row) => Object.values(row)[0]);

    const result = {
        version: 'clover.phase0.live-verification.v1',
        blankIdentityCount: Number(blank?.total || 0),
        archiveCount: Number(archive?.total || 0),
        triggerNames: triggers.map((row) => row.name),
        triggerCount: triggers.length,
        batchId,
        batchStatus: batch?.status || null,
        mappedCount: mapped.length,
        activeMappedCount: mapped.filter((row) => row.status === 'active').length,
        activeCanonicalCount: Number(activeCanonical?.total || 0),
        grantedEventCount: Number(grantedEvents?.total || 0),
        legacyAdminCount: Number(legacyAdmin?.total || 0),
        legacyAccessCount: Number(legacyAccess?.total || 0),
        integrityValues,
        integrityOk: integrityValues.length === 1 && integrityValues[0] === 'ok',
        verifiedAt: new Date().toISOString(),
    };

    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
    });
    console.log(JSON.stringify(result, null, 2));
} finally {
    db.close();
}
'@

    $ScriptPath = [System.IO.Path]::ChangeExtension($OutputPath, '.cjs')
    $Encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($ScriptPath, $Code, $Encoding)

    node $ScriptPath $Database $OutputPath $ExpectedBatchId
    Assert-LastExitCode -Message 'A verificação final do banco falhou.'

    return Get-Content $OutputPath -Raw | ConvertFrom-Json
}
