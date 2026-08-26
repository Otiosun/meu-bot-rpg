'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { OWNER_NUMBERS } = require('../helpers/groupAccess');
const { resetPlayer } = require('../helpers/clover/playerResetService');
const {
    applyGlobalPlayerReset,
    getGlobalPlayerResetOperation,
    planGlobalPlayerReset,
} = require('../helpers/clover/globalPlayerResetService');
const {
    recoverGlobalPlayerResetExecution,
} = require('../helpers/clover/globalPlayerResetRecovery');

const OWNER = `${[...OWNER_NUMBERS][0]}@s.whatsapp.net`;

function makeTempDatabase(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-global-reset-recovery-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'database.sqlite');
}

function setSwitches(t, operationId) {
    const old = {
        enabled: process.env.CLOVER_GLOBAL_RESET_ENABLED,
        operationId: process.env.CLOVER_GLOBAL_RESET_OPERATION_ID,
        recovery: process.env.CLOVER_GLOBAL_RESET_RECOVER_EXECUTION,
    };
    process.env.CLOVER_GLOBAL_RESET_ENABLED = 'YES';
    process.env.CLOVER_GLOBAL_RESET_OPERATION_ID = operationId;
    process.env.CLOVER_GLOBAL_RESET_RECOVER_EXECUTION = 'YES';
    t.after(() => {
        for (const [key, value] of Object.entries({
            CLOVER_GLOBAL_RESET_ENABLED: old.enabled,
            CLOVER_GLOBAL_RESET_OPERATION_ID: old.operationId,
            CLOVER_GLOBAL_RESET_RECOVER_EXECUTION: old.recovery,
        })) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
}

async function closeQuietly(db) {
    if (db && typeof db.close === 'function') await db.close().catch(() => {});
}

test('crash recovery exige token exato, reconcilia child commit e retoma sem duplicar reset', async (t) => {
    const filename = makeTempDatabase(t);
    let db;
    try {
        db = await database.criarBanco({ filename });
        await db.run(
            `INSERT INTO jogadores (id,nome,personagem_nome,dinheiro,raca)
             VALUES ('a@lid','A','Personagem A',100,'Humano'),
                    ('b@lid','B','Personagem B',200,'Humano')`
        );

        const plan = await planGlobalPlayerReset(db, {
            actorId: OWNER,
            reason: 'Reset global recovery drill descartável',
            playerIds: ['a@lid', 'b@lid'],
            selectionSource: 'fixture explícita recovery drill',
            operationId: 'GR-RECOVERY-0001',
        });
        const journal = await getGlobalPlayerResetOperation(db, plan.operationId);
        const first = journal.items[0];
        const orphanToken = 'GX-ORPHAN-RECOVERY-TEST';

        await db.run(
            `UPDATE clover_global_player_reset_operations
             SET status='running',execution_token=?
             WHERE operation_id=?`,
            [orphanToken, plan.operationId]
        );
        await db.run(
            `UPDATE clover_global_player_reset_items
             SET status='processing',attempt_count=1,started_at=CURRENT_TIMESTAMP
             WHERE operation_id=? AND player_id=?`,
            [plan.operationId, first.player_id]
        );

        const child = await resetPlayer(db, {
            playerId: first.player_id,
            reason: 'Reset global recovery drill descartável',
            actorId: OWNER,
            operationCode: first.reset_operation_code,
        });
        assert.equal(child.ok, true);
        assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_player_reset_events')).total, 1);

        setSwitches(t, plan.operationId);
        await assert.rejects(
            recoverGlobalPlayerResetExecution(db, {
                operationId: plan.operationId,
                actorId: OWNER,
                expectedExecutionToken: 'GX-WRONG-TOKEN',
            }),
            (error) => error.code === 'global_reset_recovery_token_mismatch'
        );
        assert.equal(
            (await db.get('SELECT execution_token FROM clover_global_player_reset_operations WHERE operation_id=?', [plan.operationId])).execution_token,
            orphanToken
        );

        const recovered = await recoverGlobalPlayerResetExecution(db, {
            operationId: plan.operationId,
            actorId: OWNER,
            expectedExecutionToken: orphanToken,
        });
        assert.equal(recovered.ok, true);
        assert.equal(recovered.status, 'paused');
        assert.equal(recovered.reconciledCount, 1);

        const afterRecovery = await getGlobalPlayerResetOperation(db, plan.operationId);
        assert.equal(afterRecovery.operation.execution_token, null);
        assert.equal(afterRecovery.items[0].status, 'reconciled');
        assert.equal(afterRecovery.items[1].status, 'pending');

        const resumed = await applyGlobalPlayerReset(db, {
            operationId: plan.operationId,
            actorId: OWNER,
        });
        assert.equal(resumed.ok, true);
        assert.equal(resumed.appliedCount, 2);
        assert.equal(resumed.reconciledCount, 1);
        assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_player_reset_events')).total, 2);

        const players = await db.all(
            `SELECT id,personagem_nome FROM jogadores WHERE id IN ('a@lid','b@lid') ORDER BY id`
        );
        assert.deepEqual(players, [
            { id: 'a@lid', personagem_nome: '-' },
            { id: 'b@lid', personagem_nome: '-' },
        ]);
    } finally {
        await closeQuietly(db);
    }
});
