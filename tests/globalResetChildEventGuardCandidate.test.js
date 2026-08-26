'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { OWNER_NUMBERS } = require('../helpers/groupAccess');
const {
    GLOBAL_RESET_CHILD_EVENT_GUARD_MIGRATION,
    inspectGlobalResetChildEventGuardDataState,
    inspectGlobalResetChildEventGuardSchemaState,
} = require('../helpers/clover/globalResetChildEventGuardMigration');
const {
    captureResetSnapshot,
    resetPlayer,
    restorePlayerReset,
} = require('../helpers/clover/playerResetService');
const {
    getGlobalPlayerResetOperation,
    planGlobalPlayerReset,
} = require('../helpers/clover/globalPlayerResetService');

const OWNER = `${[...OWNER_NUMBERS][0]}@s.whatsapp.net`;
const PLAN_REASON = 'Reset global guard 0033 descartável';

function makeTempDatabase(t, prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const filename = path.join(dir, 'database.sqlite');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return filename;
}

async function closeQuietly(db) {
    if (db && typeof db.close === 'function') await db.close().catch(() => {});
}

async function applyCandidateMigration(db) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        await GLOBAL_RESET_CHILD_EVENT_GUARD_MIGRATION.up(db);
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function seedPlayer(db, playerId, personagemNome) {
    await db.run(
        `INSERT INTO jogadores (id,nome,personagem_nome,dinheiro,raca)
         VALUES (?,?,?,?,?)`,
        [playerId, playerId, personagemNome, 100, 'Humano']
    );
}

async function prepareRunningGlobalChild(db, operationId = 'GR-GUARD-0033') {
    await seedPlayer(db, 'guard-a@lid', 'Personagem Guard A');
    const plan = await planGlobalPlayerReset(db, {
        actorId: OWNER,
        reason: PLAN_REASON,
        playerIds: ['guard-a@lid'],
        selectionSource: 'fixture explícita guard 0033',
        operationId,
    });
    const journal = await getGlobalPlayerResetOperation(db, operationId);
    const item = journal.items[0];
    await db.run(
        `UPDATE clover_global_player_reset_operations
         SET status='running',execution_token='GX-GUARD-0033'
         WHERE operation_id=?`,
        [operationId]
    );
    await db.run(
        `UPDATE clover_global_player_reset_items
         SET status='processing',attempt_count=1,started_at=CURRENT_TIMESTAMP
         WHERE operation_id=? AND player_id=?`,
        [operationId, item.player_id]
    );
    return { plan, item };
}

function syntheticAfter(before, playerId) {
    return {
        capturedAt: new Date().toISOString(),
        player: {
            ...(before.player || {}),
            id: playerId,
            personagem_nome: '-',
            jogo_status: 'bloqueado',
        },
        tables: {},
        queueEntries: [],
        reservations: [],
        leadership: [],
        antiGhost: null,
        archiveRecord: null,
    };
}

function syntheticResult() {
    return {
        deletedByTable: {},
        deletedRows: 0,
        queueClosed: 0,
        reservationsReleased: 0,
        leadershipCleared: 0,
        antiGhostReset: 0,
        archiveMarkedDeleted: 0,
        preserved: { playerId: true },
    };
}

async function insertSyntheticGlobalEvent(db, item, patch = {}) {
    const before = patch.before || await captureResetSnapshot(db, item.player_id);
    const after = patch.after || syntheticAfter(before, item.player_id);
    const result = patch.result || syntheticResult();
    return db.run(
        `INSERT INTO clover_player_reset_events
         (operation_code,player_id,scope,reason,status,created_by,before_json,after_json,result_json)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
            patch.operationCode || item.reset_operation_code,
            patch.playerId || item.player_id,
            patch.scope || 'character',
            patch.reason || PLAN_REASON,
            patch.status || 'applied',
            Object.prototype.hasOwnProperty.call(patch, 'createdBy') ? patch.createdBy : OWNER,
            JSON.stringify(before),
            JSON.stringify(after),
            JSON.stringify(result),
        ]
    );
}

test('candidate 0033 instala três guards exatos sobre head0032 vazio', async (t) => {
    const filename = makeTempDatabase(t, 'clover-child-event-guard-schema-');
    let db;
    try {
        db = await database.criarBanco({ filename });
        assert.equal((await inspectGlobalResetChildEventGuardDataState(db)).kind, 'empty');
        assert.equal((await inspectGlobalResetChildEventGuardSchemaState(db)).kind, 'absent');
        await applyCandidateMigration(db);
        const state = await inspectGlobalResetChildEventGuardSchemaState(db);
        assert.equal(state.kind, 'exact');
        assert.equal(state.objects.length, 3);
        assert.equal(state.objects.every((entry) => entry.exact), true);
    } finally {
        await closeQuietly(db);
    }
});

test('candidate 0033 bloqueia evento RS-G fora do journal ativo e metadados falsos', async (t) => {
    const filename = makeTempDatabase(t, 'clover-child-event-guard-fake-');
    let db;
    try {
        db = await database.criarBanco({ filename });
        await applyCandidateMigration(db);
        const { item } = await prepareRunningGlobalChild(db);
        const before = await captureResetSnapshot(db, item.player_id);
        const after = syntheticAfter(before, item.player_id);

        await assert.rejects(
            insertSyntheticGlobalEvent(db, item, { reason: 'Motivo divergente', before, after }),
            /global_reset_child_event_guard/
        );
        await assert.rejects(
            insertSyntheticGlobalEvent(db, item, { createdBy: null, before, after }),
            /global_reset_child_event_guard/
        );
        await assert.rejects(
            insertSyntheticGlobalEvent(db, item, {
                before,
                after: { ...after, player: { ...after.player, personagem_nome: 'Ainda ativo' } },
            }),
            /global_reset_child_event_guard/
        );
        await db.run(
            `UPDATE clover_global_player_reset_items SET status='pending'
             WHERE operation_id=? AND player_id=?`,
            ['GR-GUARD-0033', item.player_id]
        );
        await assert.rejects(
            insertSyntheticGlobalEvent(db, item, { before, after }),
            /global_reset_child_event_guard/
        );
        assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_player_reset_events')).total, 0);
    } finally {
        await closeQuietly(db);
    }
});

test('candidate 0033 aceita child reset real, congela evidência e permite restore legítimo', async (t) => {
    const filename = makeTempDatabase(t, 'clover-child-event-guard-real-');
    let db;
    try {
        db = await database.criarBanco({ filename });
        await applyCandidateMigration(db);
        const { item } = await prepareRunningGlobalChild(db, 'GR-GUARD-REAL-0033');

        const child = await resetPlayer(db, {
            playerId: item.player_id,
            reason: PLAN_REASON,
            actorId: OWNER,
            operationCode: item.reset_operation_code,
            expectedBeforeSnapshotSha256: item.planned_snapshot_sha256,
        });
        assert.equal(child.ok, true);

        const event = await db.get(
            `SELECT * FROM clover_player_reset_events WHERE operation_code=?`,
            [item.reset_operation_code]
        );
        assert.equal(event.status, 'applied');
        assert.equal(event.reason, PLAN_REASON);
        assert.equal(event.created_by, OWNER);

        await assert.rejects(
            db.run(
                `UPDATE clover_player_reset_events SET reason='adulterado' WHERE id=?`,
                [event.id]
            ),
            /global_reset_child_event_evidence_frozen/
        );
        await assert.rejects(
            db.run('DELETE FROM clover_player_reset_events WHERE id=?', [event.id]),
            /global_reset_child_event_delete_forbidden/
        );

        const restored = await restorePlayerReset(db, {
            sourceCode: item.reset_operation_code,
            reason: 'Restore descartável compatível com guard 0033',
            actorId: OWNER,
            operationCode: 'RR-GUARD-0033',
        });
        assert.equal(restored.ok, true);
        const afterRestore = await db.get(
            `SELECT status,restored_by,restore_operation_code,reason,before_json,after_json,result_json
             FROM clover_player_reset_events WHERE id=?`,
            [event.id]
        );
        assert.equal(afterRestore.status, 'restored');
        assert.equal(afterRestore.restored_by, OWNER);
        assert.equal(afterRestore.restore_operation_code, 'RR-GUARD-0033');
        assert.equal(afterRestore.reason, event.reason);
        assert.equal(afterRestore.before_json, event.before_json);
        assert.equal(afterRestore.after_json, event.after_json);
        assert.equal(afterRestore.result_json, event.result_json);
    } finally {
        await closeQuietly(db);
    }
});

test('candidate 0033 não interfere em reset individual RS-*', async (t) => {
    const filename = makeTempDatabase(t, 'clover-child-event-guard-individual-');
    let db;
    try {
        db = await database.criarBanco({ filename });
        await applyCandidateMigration(db);
        await seedPlayer(db, 'individual@lid', 'Personagem Individual');
        const result = await resetPlayer(db, {
            playerId: 'individual@lid',
            reason: 'Reset individual descartável',
            actorId: OWNER,
            operationCode: 'RS-INDIVIDUAL-0033',
        });
        assert.equal(result.ok, true);
        assert.equal(
            (await db.get(
                `SELECT COUNT(*) AS total FROM clover_player_reset_events WHERE operation_code='RS-INDIVIDUAL-0033'`
            )).total,
            1
        );
    } finally {
        await closeQuietly(db);
    }
});

test('candidate 0033 recusa upgrade se já existir qualquer evento RS-G', async (t) => {
    const filename = makeTempDatabase(t, 'clover-child-event-guard-lineage-');
    let db;
    try {
        db = await database.criarBanco({ filename });
        const { item } = await prepareRunningGlobalChild(db, 'GR-GUARD-LINEAGE-0033');
        const child = await resetPlayer(db, {
            playerId: item.player_id,
            reason: PLAN_REASON,
            actorId: OWNER,
            operationCode: item.reset_operation_code,
            expectedBeforeSnapshotSha256: item.planned_snapshot_sha256,
        });
        assert.equal(child.ok, true);
        assert.equal((await inspectGlobalResetChildEventGuardDataState(db)).kind, 'nonempty');

        await assert.rejects(
            applyCandidateMigration(db),
            (error) => error?.code === 'global_reset_child_event_guard_data_reconciliation_required'
                && error?.state?.globalEventCount === 1
        );
        assert.equal((await inspectGlobalResetChildEventGuardSchemaState(db)).kind, 'absent');
        assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_player_reset_events')).total, 1);
    } finally {
        await closeQuietly(db);
    }
});
