'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { OWNER_NUMBERS } = require('../helpers/groupAccess');
const {
    applyGlobalPlayerReset,
    planGlobalPlayerReset,
    reconcileGlobalPlayerReset,
} = require('../helpers/clover/globalPlayerResetService');
const {
    backupSqliteDatabase,
    restoreSqliteBackupToNewPath,
    verifySqliteDatabase,
} = require('../helpers/clover/sqliteBackupService');
const { assertDatabaseAtCanonicalMigrationHead } = require('../helpers/ci/f10MigrationGate');

const OWNER = `${[...OWNER_NUMBERS][0]}@s.whatsapp.net`;

function tempPaths(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-reset-go-no-go-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return {
        source: path.join(dir, 'source.sqlite'),
        backup: path.join(dir, 'backup.sqlite'),
        restored: path.join(dir, 'restored.sqlite'),
    };
}

async function closeQuietly(db) {
    if (db && typeof db.close === 'function') await db.close().catch(() => {});
}

function assertPhysicalVerification(result) {
    assert.equal(result.quick, 'ok');
    assert.equal(result.integrity, 'ok');
    assert.equal(result.foreignKeyViolations, 0);
}

function pinReset(t, operationId) {
    const oldEnabled = process.env.CLOVER_GLOBAL_RESET_ENABLED;
    const oldOperation = process.env.CLOVER_GLOBAL_RESET_OPERATION_ID;
    const oldAuthorization = process.env.CLOVER_RESET_EXECUTION_AUTHORIZED;
    process.env.CLOVER_GLOBAL_RESET_ENABLED = 'YES';
    process.env.CLOVER_GLOBAL_RESET_OPERATION_ID = operationId;
    process.env.CLOVER_RESET_EXECUTION_AUTHORIZED = 'YES';
    t.after(() => {
        if (oldEnabled === undefined) delete process.env.CLOVER_GLOBAL_RESET_ENABLED;
        else process.env.CLOVER_GLOBAL_RESET_ENABLED = oldEnabled;
        if (oldOperation === undefined) delete process.env.CLOVER_GLOBAL_RESET_OPERATION_ID;
        else process.env.CLOVER_GLOBAL_RESET_OPERATION_ID = oldOperation;
        if (oldAuthorization === undefined) delete process.env.CLOVER_RESET_EXECUTION_AUTHORIZED;
        else process.env.CLOVER_RESET_EXECUTION_AUTHORIZED = oldAuthorization;
    });
}

test('RESET_GO_NO_GO smoke: backup -> global reset -> reconcile -> restore novo arquivo -> bootstrap preserva sentinelas', async (t) => {
    const paths = tempPaths(t);
    let sourceDb;
    let restoredDb;
    try {
        sourceDb = await database.criarBanco({ filename: paths.source });
        const preBackupMigrationState = await assertDatabaseAtCanonicalMigrationHead(sourceDb);
        assert.equal(preBackupMigrationState.userVersion, 37);
        assert.equal(preBackupMigrationState.chain.latestVersion, 37);
        assert.equal(preBackupMigrationState.chain.latestKey, '0037_prereset_admin_roster_launch');
        assert.equal(preBackupMigrationState.schemaFingerprintMatchesLatest, true);

        await sourceDb.run(
            `INSERT INTO jogadores (id,nome,personagem_nome,dinheiro,raca)
             VALUES ('reset-a@lid','Reset A','Personagem A',111,'Humano'),
                    ('reset-b@lid','Reset B','Personagem B',222,'Humano')`
        );
        const before = await sourceDb.all(
            `SELECT id,personagem_nome,dinheiro,raca
             FROM jogadores WHERE id IN ('reset-a@lid','reset-b@lid') ORDER BY id`
        );
        assert.deepEqual(before, [
            { id: 'reset-a@lid', personagem_nome: 'Personagem A', dinheiro: 111, raca: 'Humano' },
            { id: 'reset-b@lid', personagem_nome: 'Personagem B', dinheiro: 222, raca: 'Humano' },
        ]);
        await closeQuietly(sourceDb);
        sourceDb = null;

        const backup = await backupSqliteDatabase(paths.source, paths.backup);
        assertPhysicalVerification(backup);
        assert.ok(backup.bytes > 0);
        assert.match(backup.sha256, /^[a-f0-9]{64}$/);

        sourceDb = await database.criarBanco({ filename: paths.source });
        const plan = await planGlobalPlayerReset(sourceDb, {
            actorId: OWNER,
            reason: 'RESET_GO_NO_GO smoke descartável',
            playerIds: ['reset-a@lid', 'reset-b@lid'],
            selectionSource: 'sentinelas explícitas do smoke P0',
            operationId: 'GR-SMOKE-0001',
        });
        assert.equal(plan.expectedCount, 2);
        pinReset(t, plan.operationId);

        const applied = await applyGlobalPlayerReset(sourceDb, {
            operationId: plan.operationId,
            actorId: OWNER,
        });
        assert.equal(applied.ok, true);
        assert.equal(applied.appliedCount, 2);
        assert.equal(applied.failedCount, 0);

        const reconciled = await reconcileGlobalPlayerReset(sourceDb, {
            operationId: plan.operationId,
            actorId: OWNER,
        });
        assert.equal(reconciled.ok, true);
        assert.equal(reconciled.appliedCount, 2);

        const resetRows = await sourceDb.all(
            `SELECT id,personagem_nome,ficha_status,jogo_status
             FROM jogadores WHERE id IN ('reset-a@lid','reset-b@lid') ORDER BY id`
        );
        assert.deepEqual(resetRows, [
            { id: 'reset-a@lid', personagem_nome: '-', ficha_status: 'incompleta', jogo_status: 'bloqueado' },
            { id: 'reset-b@lid', personagem_nome: '-', ficha_status: 'incompleta', jogo_status: 'bloqueado' },
        ]);

        const postResetJournalCounts = await sourceDb.get(`
            SELECT
                (SELECT COUNT(*) FROM clover_player_reset_events) AS playerResetEvents,
                (SELECT COUNT(*) FROM clover_player_reset_restores) AS playerResetRestores,
                (SELECT COUNT(*) FROM clover_global_player_reset_operations) AS globalResetOperations,
                (SELECT COUNT(*) FROM clover_global_player_reset_items) AS globalResetItems,
                (SELECT COUNT(*) FROM clover_global_player_reset_lock) AS globalResetLocks,
                (SELECT COUNT(*) FROM clover_script_runs) AS cloverScriptRuns,
                (SELECT COUNT(*) FROM clover_script_actions) AS cloverScriptActions
        `);
        assert.deepEqual(postResetJournalCounts, {
            playerResetEvents: 2,
            playerResetRestores: 0,
            globalResetOperations: 1,
            globalResetItems: 2,
            globalResetLocks: 1,
            cloverScriptRuns: 0,
            cloverScriptActions: 0,
        });
        await closeQuietly(sourceDb);
        sourceDb = null;

        const restored = await restoreSqliteBackupToNewPath(paths.backup, paths.restored, {
            expectedSha256: backup.sha256,
        });
        assertPhysicalVerification(restored);
        assert.equal(restored.sourceSha256, backup.sha256);
        assert.equal(restored.expectedSha256, backup.sha256);
        assert.equal(restored.sha256, backup.sha256);
        assert.equal(restored.bytes, backup.bytes);
        const verification = await verifySqliteDatabase(paths.restored);
        assert.equal(verification.ok, true);
        assertPhysicalVerification(verification);

        restoredDb = await database.criarBanco({ filename: paths.restored });
        const restoredMigrationState = await assertDatabaseAtCanonicalMigrationHead(restoredDb);
        assert.equal(restoredMigrationState.userVersion, preBackupMigrationState.userVersion);
        assert.equal(restoredMigrationState.chain.latestVersion, preBackupMigrationState.chain.latestVersion);
        assert.equal(restoredMigrationState.chain.latestKey, preBackupMigrationState.chain.latestKey);
        assert.equal(restoredMigrationState.schemaFingerprintMatchesLatest, true);
        assert.equal(
            restoredMigrationState.currentSchemaFingerprint,
            preBackupMigrationState.currentSchemaFingerprint
        );

        const recovered = await restoredDb.all(
            `SELECT id,personagem_nome,dinheiro,raca
             FROM jogadores WHERE id IN ('reset-a@lid','reset-b@lid') ORDER BY id`
        );
        assert.deepEqual(recovered, before);

        const restoredJournalTables = await restoredDb.all(
            `SELECT name
             FROM sqlite_schema
             WHERE type = 'table'
               AND name IN (
                   'clover_player_reset_events',
                   'clover_player_reset_restores',
                   'clover_global_player_reset_operations',
                   'clover_global_player_reset_items',
                   'clover_global_player_reset_lock',
                   'clover_script_runs',
                   'clover_script_actions'
               )
             ORDER BY name`
        );
        assert.deepEqual(restoredJournalTables.map((row) => row.name), [
            'clover_global_player_reset_items',
            'clover_global_player_reset_lock',
            'clover_global_player_reset_operations',
            'clover_player_reset_events',
            'clover_player_reset_restores',
            'clover_script_actions',
            'clover_script_runs',
        ]);

        const restoredJournalCounts = await restoredDb.get(`
            SELECT
                (SELECT COUNT(*) FROM clover_player_reset_events) AS playerResetEvents,
                (SELECT COUNT(*) FROM clover_player_reset_restores) AS playerResetRestores,
                (SELECT COUNT(*) FROM clover_global_player_reset_operations) AS globalResetOperations,
                (SELECT COUNT(*) FROM clover_global_player_reset_items) AS globalResetItems,
                (SELECT COUNT(*) FROM clover_global_player_reset_lock) AS globalResetLocks,
                (SELECT COUNT(*) FROM clover_script_runs) AS cloverScriptRuns,
                (SELECT COUNT(*) FROM clover_script_actions) AS cloverScriptActions
        `);
        assert.deepEqual(restoredJournalCounts, {
            playerResetEvents: 0,
            playerResetRestores: 0,
            globalResetOperations: 0,
            globalResetItems: 0,
            globalResetLocks: 0,
            cloverScriptRuns: 0,
            cloverScriptActions: 0,
        });
    } finally {
        await closeQuietly(sourceDb);
        await closeQuietly(restoredDb);
    }
});
