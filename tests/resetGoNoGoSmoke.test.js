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

function pinReset(t, operationId) {
    const oldEnabled = process.env.CLOVER_GLOBAL_RESET_ENABLED;
    const oldOperation = process.env.CLOVER_GLOBAL_RESET_OPERATION_ID;
    process.env.CLOVER_GLOBAL_RESET_ENABLED = 'YES';
    process.env.CLOVER_GLOBAL_RESET_OPERATION_ID = operationId;
    t.after(() => {
        if (oldEnabled === undefined) delete process.env.CLOVER_GLOBAL_RESET_ENABLED;
        else process.env.CLOVER_GLOBAL_RESET_ENABLED = oldEnabled;
        if (oldOperation === undefined) delete process.env.CLOVER_GLOBAL_RESET_OPERATION_ID;
        else process.env.CLOVER_GLOBAL_RESET_OPERATION_ID = oldOperation;
    });
}

test('RESET_GO_NO_GO smoke: backup -> global reset -> reconcile -> restore novo arquivo -> bootstrap preserva sentinelas', async (t) => {
    const paths = tempPaths(t);
    let sourceDb;
    let restoredDb;
    try {
        sourceDb = await database.criarBanco({ filename: paths.source });
        await assertDatabaseAtCanonicalMigrationHead(sourceDb);
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
        assert.equal(backup.integrity, 'ok');
        assert.ok(backup.bytes > 0);

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
        await closeQuietly(sourceDb);
        sourceDb = null;

        const restored = await restoreSqliteBackupToNewPath(paths.backup, paths.restored);
        assert.equal(restored.integrity, 'ok');
        const verification = await verifySqliteDatabase(paths.restored);
        assert.equal(verification.ok, true);

        restoredDb = await database.criarBanco({ filename: paths.restored });
        await assertDatabaseAtCanonicalMigrationHead(restoredDb);
        const recovered = await restoredDb.all(
            `SELECT id,personagem_nome,dinheiro,raca
             FROM jogadores WHERE id IN ('reset-a@lid','reset-b@lid') ORDER BY id`
        );
        assert.deepEqual(recovered, before);

        const restoredGlobalOps = await restoredDb.get(
            `SELECT COUNT(*) AS total
             FROM sqlite_master WHERE type='table' AND name='clover_global_player_reset_operations'`
        );
        assert.equal(restoredGlobalOps.total, 0);
    } finally {
        await closeQuietly(sourceDb);
        await closeQuietly(restoredDb);
    }
});
