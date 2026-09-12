'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { OWNER_NUMBERS } = require('../helpers/groupAccess');
const { resetPlayer } = require('../helpers/clover/playerResetService');
const {
    applyGlobalPlayerReset,
    getGlobalPlayerResetOperation,
    planGlobalPlayerReset,
    reconcileGlobalPlayerReset,
    snapshotHash,
} = require('../helpers/clover/globalPlayerResetService');
const { recoverGlobalPlayerResetExecution } = require('../helpers/clover/globalPlayerResetRecovery');
const { inspectChildResetEventBinding } = require('../helpers/clover/globalPlayerResetEventBinding');

const OWNER = `${[...OWNER_NUMBERS][0]}@s.whatsapp.net`;

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            nome_real TEXT,
            personagem_nome TEXT,
            personagem_idade INTEGER,
            ficha_status TEXT,
            historia_status TEXT,
            personagem_aparencia_status TEXT,
            jogo_status TEXT,
            esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0,
            dinheiro INTEGER DEFAULT 0,
            reino TEXT DEFAULT '-',
            magia TEXT DEFAULT '-',
            grimorio TEXT DEFAULT '-',
            patente TEXT DEFAULT '-',
            lifecycle_status TEXT DEFAULT 'active',
            is_shadow INTEGER DEFAULT 0,
            identity_status TEXT DEFAULT 'active',
            merged_into TEXT DEFAULT NULL
        );
        CREATE TABLE clover_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE clover_ph_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL,
            kind TEXT NOT NULL,
            source TEXT,
            reason TEXT
        );
        INSERT INTO jogadores
        (id,nome,nome_real,personagem_nome,personagem_idade,ficha_status,historia_status,
         personagem_aparencia_status,jogo_status,dinheiro,is_shadow)
        VALUES ('a@lid','A','Pessoa A','Personagem A',19,'aprovada','aprovada','approved','liberado',100,0);
    `);
    return db;
}

function setSwitches(t, operationId, { recovery = false } = {}) {
    const keys = [
        'CLOVER_GLOBAL_RESET_ENABLED',
        'CLOVER_GLOBAL_RESET_OPERATION_ID',
        'CLOVER_RESET_EXECUTION_AUTHORIZED',
        'CLOVER_GLOBAL_RESET_RECOVER_EXECUTION',
    ];
    const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.CLOVER_GLOBAL_RESET_ENABLED = 'YES';
    process.env.CLOVER_GLOBAL_RESET_OPERATION_ID = operationId;
    process.env.CLOVER_RESET_EXECUTION_AUTHORIZED = 'YES';
    if (recovery) process.env.CLOVER_GLOBAL_RESET_RECOVER_EXECUTION = 'YES';
    t.after(() => {
        for (const key of keys) {
            if (before[key] === undefined) delete process.env[key];
            else process.env[key] = before[key];
        }
    });
}

async function makePlan(db, operationId) {
    return planGlobalPlayerReset(db, {
        actorId: OWNER,
        reason: 'Reset global sintético para binding de evento',
        playerIds: ['a@lid'],
        selectionSource: 'fixture explícita binding child event',
        operationId,
    });
}

async function insertForgedEvent(db, item, beforeJson = '{}') {
    await db.run(
        `INSERT INTO clover_player_reset_events
         (operation_code,player_id,scope,reason,status,created_by,before_json,after_json,result_json)
         VALUES (?,?,'character','evento sintético plantado','applied',?,?,?,?)`,
        [item.reset_operation_code, item.player_id, OWNER, beforeJson, '{}', '{}']
    );
}

test('binding puro exige operation/player/status/scope e hash do before_snapshot congelado', () => {
    const snapshot = { capturedAt: 'A', player: { id: 'a@lid', dinheiro: 100 }, tables: {} };
    const item = {
        reset_operation_code: 'RS-G-BOUND',
        player_id: 'a@lid',
        planned_snapshot_sha256: snapshotHash(snapshot),
    };
    const event = {
        operation_code: 'RS-G-BOUND',
        player_id: 'a@lid',
        scope: 'character',
        status: 'applied',
        before_json: JSON.stringify({ ...snapshot, capturedAt: 'B' }),
    };
    assert.equal(inspectChildResetEventBinding(item, event).ok, true);

    const forged = inspectChildResetEventBinding(item, { ...event, before_json: '{}' });
    assert.equal(forged.ok, false);
    assert.equal(forged.code, 'child_event_snapshot_mismatch');
});

test('child reset revalida snapshot congelado dentro da própria transação antes de escrever', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const plan = await makePlan(db, 'GR-BINDING-CHILD-TOCTOU');
    const journal = await getGlobalPlayerResetOperation(db, plan.operationId);
    const item = journal.items[0];

    await db.run("UPDATE jogadores SET dinheiro=101 WHERE id='a@lid'");
    const result = await resetPlayer(db, {
        playerId: item.player_id,
        reason: 'Reset global sintético para binding de evento',
        actorId: OWNER,
        operationCode: item.reset_operation_code,
        expectedBeforeSnapshotSha256: item.planned_snapshot_sha256,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'planned_snapshot_drift');
    assert.equal(result.details?.expectedSha256, item.planned_snapshot_sha256);
    assert.notEqual(result.details?.actualSha256, item.planned_snapshot_sha256);
    assert.deepEqual(
        await db.get("SELECT personagem_nome,dinheiro FROM jogadores WHERE id='a@lid'"),
        { personagem_nome: 'Personagem A', dinheiro: 101 }
    );
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_player_reset_events')).total, 0);
});

test('apply recusa child event plantado antes de qualquer mutação', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const plan = await makePlan(db, 'GR-BINDING-APPLY');
    const journal = await getGlobalPlayerResetOperation(db, plan.operationId);
    await insertForgedEvent(db, journal.items[0]);
    setSwitches(t, plan.operationId);

    await assert.rejects(
        applyGlobalPlayerReset(db, { operationId: plan.operationId, actorId: OWNER }),
        (error) => error.code === 'global_reset_child_event_binding_mismatch'
            && error.details?.binding?.code === 'child_event_snapshot_mismatch'
            && error.details?.phase === 'cohort_preflight_existing_event'
    );

    assert.equal((await db.get("SELECT personagem_nome FROM jogadores WHERE id='a@lid'")).personagem_nome, 'Personagem A');
    const after = await getGlobalPlayerResetOperation(db, plan.operationId);
    assert.equal(after.operation.status, 'paused');
    assert.equal(after.operation.execution_token, null);
    assert.equal(after.items[0].status, 'pending');
});

test('reconcile não promove child event plantado para reconciled', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const plan = await makePlan(db, 'GR-BINDING-RECONCILE');
    const journal = await getGlobalPlayerResetOperation(db, plan.operationId);
    await insertForgedEvent(db, journal.items[0]);
    await db.run(
        `UPDATE clover_global_player_reset_operations SET status='paused' WHERE operation_id=?`,
        [plan.operationId]
    );

    const result = await reconcileGlobalPlayerReset(db, { operationId: plan.operationId, actorId: OWNER });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'paused');
    assert.equal(result.issues[0].code, 'event_binding_mismatch');
    assert.equal(result.issues[0].binding.code, 'child_event_snapshot_mismatch');
    const after = await getGlobalPlayerResetOperation(db, plan.operationId);
    assert.equal(after.items[0].status, 'pending');
    assert.equal((await db.get("SELECT personagem_nome FROM jogadores WHERE id='a@lid'")).personagem_nome, 'Personagem A');
});

test('recovery recusa child event plantado e preserva executor órfão para investigação', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const plan = await makePlan(db, 'GR-BINDING-RECOVERY');
    const journal = await getGlobalPlayerResetOperation(db, plan.operationId);
    const item = journal.items[0];
    const token = 'GX-BINDING-ORPHAN';
    await insertForgedEvent(db, item);
    await db.run(
        `UPDATE clover_global_player_reset_operations
         SET status='running',execution_token=? WHERE operation_id=?`,
        [token, plan.operationId]
    );
    await db.run(
        `UPDATE clover_global_player_reset_items
         SET status='processing',attempt_count=1 WHERE operation_id=? AND player_id=?`,
        [plan.operationId, item.player_id]
    );
    setSwitches(t, plan.operationId, { recovery: true });

    await assert.rejects(
        recoverGlobalPlayerResetExecution(db, {
            operationId: plan.operationId,
            actorId: OWNER,
            expectedExecutionToken: token,
        }),
        (error) => error.code === 'global_reset_recovery_event_binding_mismatch'
            && error.details?.binding?.code === 'child_event_snapshot_mismatch'
    );

    const after = await getGlobalPlayerResetOperation(db, plan.operationId);
    assert.equal(after.operation.status, 'running');
    assert.equal(after.operation.execution_token, token);
    assert.equal(after.items[0].status, 'processing');
    assert.equal((await db.get("SELECT personagem_nome FROM jogadores WHERE id='a@lid'")).personagem_nome, 'Personagem A');
});
