'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { OWNER_NUMBERS } = require('../helpers/groupAccess');
const {
    applyGlobalPlayerReset,
    getGlobalPlayerResetOperation,
    planGlobalPlayerReset,
    reconcileGlobalPlayerReset,
} = require('../helpers/clover/globalPlayerResetService');
const { resetPlayer } = require('../helpers/clover/playerResetService');
const { recoverGlobalPlayerResetExecution } = require('../helpers/clover/globalPlayerResetRecovery');

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
        VALUES ('cas@lid','CAS','Pessoa CAS','Personagem CAS',19,'aprovada','aprovada','approved','liberado',100,0);
    `);
    return db;
}

function preserveEnv(t, keys) {
    const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(() => {
        for (const key of keys) {
            if (before[key] === undefined) delete process.env[key];
            else process.env[key] = before[key];
        }
    });
}

function setSwitches(t, operationId) {
    const keys = ['CLOVER_GLOBAL_RESET_ENABLED', 'CLOVER_GLOBAL_RESET_OPERATION_ID', 'CLOVER_RESET_EXECUTION_AUTHORIZED'];
    preserveEnv(t, keys);
    process.env.CLOVER_GLOBAL_RESET_ENABLED = 'YES';
    process.env.CLOVER_GLOBAL_RESET_OPERATION_ID = operationId;
    process.env.CLOVER_RESET_EXECUTION_AUTHORIZED = 'YES';
}

function setRecoverySwitches(t, operationId) {
    const keys = ['CLOVER_GLOBAL_RESET_ENABLED', 'CLOVER_GLOBAL_RESET_OPERATION_ID', 'CLOVER_GLOBAL_RESET_RECOVER_EXECUTION'];
    preserveEnv(t, keys);
    process.env.CLOVER_GLOBAL_RESET_ENABLED = 'YES';
    process.env.CLOVER_GLOBAL_RESET_OPERATION_ID = operationId;
    process.env.CLOVER_GLOBAL_RESET_RECOVER_EXECUTION = 'YES';
}

async function planOne(db, operationId, reason = 'Drill descartável de certificação pós-reset global') {
    return planGlobalPlayerReset(db, {
        actorId: OWNER,
        reason,
        playerIds: ['cas@lid'],
        selectionSource: 'fixture explícita post-state certification',
        operationId,
    });
}

function boundProxy(rawDb, overrides = {}) {
    return new Proxy(rawDb, {
        get(target, property) {
            if (Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property](target);
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

test('apply não pode retornar completed quando o CAS final afeta zero linhas', async (t) => {
    const rawDb = await createDb();
    t.after(() => rawDb.close());

    const plan = await planOne(rawDb, 'GR-COMPLETION-CAS-0001', 'Drill descartável de CAS final do reset global');
    setSwitches(t, plan.operationId);

    let completionCasIntercepted = false;
    const db = boundProxy(rawDb, {
        run: (target) => async (sql, ...args) => {
            const source = String(sql || '');
            if (source.includes("SET status='completed'") && source.includes('execution_token=NULL')) {
                completionCasIntercepted = true;
                return { changes: 0 };
            }
            return target.run(sql, ...args);
        },
    });

    await assert.rejects(
        applyGlobalPlayerReset(db, { operationId: plan.operationId, actorId: OWNER }),
        (error) => error?.code === 'global_reset_completion_compare_and_swap_failed'
    );
    assert.equal(completionCasIntercepted, true);

    const after = await getGlobalPlayerResetOperation(rawDb, plan.operationId);
    assert.notEqual(after.operation.status, 'completed');
    assert.equal(after.items[0].status, 'applied');
    assert.equal((await rawDb.get('SELECT COUNT(*) AS total FROM clover_player_reset_events')).total, 1);
});

test('certificação final bloqueia drift persistido ocorrido após child commit e antes de completed', async (t) => {
    const rawDb = await createDb();
    t.after(() => rawDb.close());

    const plan = await planOne(rawDb, 'GR-POSTSTATE-FINAL-0001');
    setSwitches(t, plan.operationId);

    let driftInjected = false;
    const db = boundProxy(rawDb, {
        exec: (target) => async (sql, ...args) => {
            const source = String(sql || '').trim().toUpperCase();
            if (!driftInjected && source === 'BEGIN IMMEDIATE') {
                const eventCount = Number((await target.get('SELECT COUNT(*) AS total FROM clover_player_reset_events')).total || 0);
                const item = await target.get(
                    'SELECT status FROM clover_global_player_reset_items WHERE operation_id=? AND player_id=?',
                    [plan.operationId, 'cas@lid']
                );
                if (eventCount === 1 && item?.status === 'applied') {
                    await target.run("UPDATE jogadores SET dinheiro=777 WHERE id='cas@lid'");
                    driftInjected = true;
                }
            }
            return target.exec(sql, ...args);
        },
    });

    await assert.rejects(
        applyGlobalPlayerReset(db, { operationId: plan.operationId, actorId: OWNER }),
        (error) => error?.code === 'global_reset_child_post_state_drift'
            && error?.details?.phase === 'final_completion_certification'
    );
    assert.equal(driftInjected, true);

    const after = await getGlobalPlayerResetOperation(rawDb, plan.operationId);
    assert.equal(after.operation.status, 'paused');
    assert.equal(after.operation.execution_token, null);
    assert.equal(after.items[0].status, 'applied');
    assert.equal((await rawDb.get("SELECT dinheiro FROM jogadores WHERE id='cas@lid'")).dinheiro, 777);
});

test('reconcile rebaixa completed para paused quando o estado atual diverge do after_json', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const plan = await planOne(db, 'GR-POSTSTATE-RECONCILE-0001');
    setSwitches(t, plan.operationId);
    const applied = await applyGlobalPlayerReset(db, { operationId: plan.operationId, actorId: OWNER });
    assert.equal(applied.status, 'completed');

    await db.run("UPDATE jogadores SET dinheiro=888 WHERE id='cas@lid'");
    const reconciled = await reconcileGlobalPlayerReset(db, { operationId: plan.operationId, actorId: OWNER });
    assert.equal(reconciled.ok, false);
    assert.equal(reconciled.status, 'paused');
    assert.equal(reconciled.issues.some((issue) => issue.code === 'post_state_drift' && issue.playerId === 'cas@lid'), true);

    const after = await getGlobalPlayerResetOperation(db, plan.operationId);
    assert.equal(after.operation.status, 'paused');
    assert.match(after.operation.last_error_json || '', /post_state_drift/);
});

test('orphan recovery recusa child event válido se o pós-reset persistido já sofreu drift', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const reason = 'Drill descartável de recovery com drift pós-reset';
    const plan = await planOne(db, 'GR-POSTSTATE-RECOVERY-0001', reason);
    const item = plan.items[0];
    const token = 'GX-POSTSTATE-RECOVERY-0001';

    await db.run(
        `UPDATE clover_global_player_reset_operations
         SET status='running',execution_token=? WHERE operation_id=?`,
        [token, plan.operationId]
    );
    await db.run(
        `UPDATE clover_global_player_reset_items
         SET status='processing',attempt_count=1 WHERE operation_id=? AND player_id=?`,
        [plan.operationId, item.playerId]
    );

    const child = await resetPlayer(db, {
        playerId: item.playerId,
        reason,
        actorId: OWNER,
        operationCode: item.resetOperationCode,
        expectedBeforeSnapshotSha256: item.snapshotSha256,
    });
    assert.equal(child.ok, true);
    await db.run("UPDATE jogadores SET dinheiro=999 WHERE id='cas@lid'");

    setRecoverySwitches(t, plan.operationId);
    await assert.rejects(
        recoverGlobalPlayerResetExecution(db, {
            operationId: plan.operationId,
            actorId: OWNER,
            expectedExecutionToken: token,
        }),
        (error) => error?.code === 'global_reset_recovery_post_state_drift'
    );

    const after = await getGlobalPlayerResetOperation(db, plan.operationId);
    assert.equal(after.operation.status, 'running');
    assert.equal(after.operation.execution_token, token);
    assert.equal(after.items[0].status, 'processing');
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_player_reset_events')).total, 1);
});
