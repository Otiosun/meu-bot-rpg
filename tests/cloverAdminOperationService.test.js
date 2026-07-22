'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    applyAdminOperation,
    approveAdminOperation,
    createAdminOperation,
    getOperationByCode,
    listAdminOperations,
    simulateAdminOperation,
    undoAdminOperation,
} = require('../helpers/clover/adminOperationService');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome TEXT,
            esquadrao TEXT,
            jogo_status TEXT,
            aptidao_comum TEXT,
            canonical_player_id TEXT,
            merged_into TEXT,
            is_shadow INTEGER DEFAULT 0,
            identity_status TEXT DEFAULT 'active'
        );

        CREATE TABLE clover_player_target_aliases (
            alias_key TEXT PRIMARY KEY,
            alias_label TEXT NOT NULL,
            player_id TEXT NOT NULL,
            alias_kind TEXT NOT NULL DEFAULT 'manual',
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        );

        CREATE TABLE clover_player_aliases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id_destino TEXT NOT NULL,
            alias_type TEXT NOT NULL,
            alias_value TEXT NOT NULL,
            source TEXT DEFAULT 'manual',
            confidence INTEGER DEFAULT 100,
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(alias_type, alias_value)
        )
    `);
    await db.run(
        `INSERT INTO jogadores
         (id, personagem_nome, nome, esquadrao, jogo_status, aptidao_comum, canonical_player_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['101@lid', 'Ragnar', 'Jogador Um', 'Lobos Cinzentos', 'Liberado', 'Antigo', '101@lid']
    );
    return db;
}

function draft(overrides = {}) {
    return {
        title: 'Atribuir traço de teste',
        reason: 'Validação do motor administrativo',
        targets: [{ kind: 'player', playerId: '101@lid' }],
        actions: [{
            type: 'player.trait.assign',
            label: 'Trocar aptidão comum',
            payload: { field: 'aptidao_comum', value: 'Persistente' },
        }],
        idempotencyKey: 'test:operation:1',
        metadata: { source: 'test' },
        ...overrides,
    };
}

const actor = { id: '111@lid', role: 'owner' };

function traitExecutor(options = {}) {
    return {
        async preview({ db, action, target }) {
            const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [target.playerId]);
            return {
                summary: `${player.personagem_nome}: ${action.payload.field}`,
                before: { value: player[action.payload.field] || null },
                after: { value: action.payload.value },
            };
        },
        async apply({ db, action, target, before, after }) {
            if (options.failApply) {
                const error = new Error('Falha intencional');
                error.code = 'intentional_failure';
                throw error;
            }
            await db.run(
                `UPDATE jogadores SET ${action.payload.field} = ? WHERE id = ?`,
                [after.value, target.playerId]
            );
            return { before, after, summary: `Aplicado em ${target.playerId}` };
        },
        async undo({ db, action, target, before }) {
            await db.run(
                `UPDATE jogadores SET ${action.payload.field} = ? WHERE id = ?`,
                [before.value, target.playerId]
            );
        },
    };
}

function executors(executor = traitExecutor()) {
    return { 'player.trait.assign': executor };
}

test('executa ciclo draft → simulated → approved → applied → undone', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const created = await createAdminOperation(db, draft(), actor, {
        randomBytes: () => Buffer.from('a1b2c3', 'hex'),
        now: new Date('2026-07-22T20:00:00.000Z'),
    });
    assert.equal(created.operation.code, 'OP-A1B2C3');
    assert.equal(created.operation.status, 'draft');

    const simulated = await simulateAdminOperation(db, created.operation.code, actor, {
        executors: executors(),
    });
    assert.equal(simulated.operation.status, 'simulated');
    assert.equal(simulated.operation.preview.targetCount, 1);
    assert.equal(simulated.operation.units[0].before.value, 'Antigo');
    assert.equal(simulated.operation.units[0].after.value, 'Persistente');

    const approved = await approveAdminOperation(db, created.operation.code, actor);
    assert.equal(approved.operation.status, 'approved');

    const applied = await applyAdminOperation(db, created.operation.code, actor, {
        executors: executors(),
    });
    assert.equal(applied.operation.status, 'applied');
    assert.equal(applied.operation.result.appliedCount, 1);
    assert.equal((await db.get('SELECT aptidao_comum FROM jogadores WHERE id = ?', ['101@lid'])).aptidao_comum, 'Persistente');

    const undone = await undoAdminOperation(db, created.operation.code, actor, {
        executors: executors(),
    });
    assert.equal(undone.operation.status, 'undone');
    assert.equal((await db.get('SELECT aptidao_comum FROM jogadores WHERE id = ?', ['101@lid'])).aptidao_comum, 'Antigo');
    assert.deepEqual(
        undone.operation.events.map((event) => event.type),
        ['created', 'simulated', 'approved', 'applying', 'applied', 'undone']
    );
});

test('repetição da mesma chave retorna a operação existente', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const first = await createAdminOperation(db, draft(), actor, {
        randomBytes: () => Buffer.from('010203', 'hex'),
    });
    const repeated = await createAdminOperation(db, draft(), actor, {
        randomBytes: () => Buffer.from('ffffff', 'hex'),
    });

    assert.equal(repeated.duplicate, true);
    assert.equal(repeated.operation.code, first.operation.code);

    await assert.rejects(
        () => createAdminOperation(db, draft({ title: 'Outra operação' }), actor),
        { code: 'idempotency_conflict', status: 409 }
    );
});

test('falha de executor produz operação failed sem alterar jogador', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const created = await createAdminOperation(db, draft({ idempotencyKey: 'test:operation:fail' }), actor, {
        randomBytes: () => Buffer.from('0f0f0f', 'hex'),
    });
    await simulateAdminOperation(db, created.operation.code, actor, { executors: executors() });
    await approveAdminOperation(db, created.operation.code, actor);
    const applied = await applyAdminOperation(db, created.operation.code, actor, {
        executors: executors(traitExecutor({ failApply: true })),
    });

    assert.equal(applied.ok, false);
    assert.equal(applied.operation.status, 'failed');
    assert.equal(applied.operation.result.failedCount, 1);
    assert.equal((await db.get('SELECT aptidao_comum FROM jogadores WHERE id = ?', ['101@lid'])).aptidao_comum, 'Antigo');
});

test('lista e consulta preservam contrato e unidades', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const created = await createAdminOperation(db, draft({ idempotencyKey: 'test:list' }), actor, {
        randomBytes: () => Buffer.from('112233', 'hex'),
    });
    const listed = await listAdminOperations(db, { query: 'Atribuir', limit: 10 });
    assert.equal(listed.operations.length, 1);
    assert.equal(listed.operations[0].code, 'OP-112233');

    const fetched = await getOperationByCode(db, created.operation.code, { includeEvents: true, includeUnits: true });
    assert.equal(fetched.version, 'clover.admin-operation.v1');
    assert.equal(fetched.events.length, 1);
    assert.deepEqual(fetched.units, []);
});
