'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    AdminProgressionError,
    createProgressionExecutors,
    deriveAllocatedAttributes,
    normalizeFinalAllocation,
    progressionSnapshot,
} = require('../helpers/clover/adminProgressionService');
const { getAdminOperationExecutors } = require('../helpers/clover/adminOperationRegistry');
const {
    normalizeAdminOperationInput,
    requiredCapabilitiesForActions,
} = require('../helpers/clover/adminOperationContract');

async function makeDb(overrides = {}) {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome TEXT
        );
        CREATE TABLE clover_character_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL UNIQUE,
            stage_key TEXT DEFAULT '9',
            pb_total INTEGER DEFAULT 10,
            pb_spent INTEGER DEFAULT 0,
            ph_accumulated INTEGER DEFAULT 0,
            ph_available INTEGER DEFAULT 0,
            forca INTEGER DEFAULT 0,
            velocidade INTEGER DEFAULT 0,
            agilidade INTEGER DEFAULT 0,
            resistencia INTEGER DEFAULT 0,
            poder_magico INTEGER DEFAULT 0,
            distribution_status TEXT DEFAULT 'pending',
            pending_distribution_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            confirmed_at TEXT DEFAULT NULL
        );
        INSERT INTO jogadores (id, personagem_nome, nome)
        VALUES ('player@test', 'Teste', 'Teste');
    `);
    const row = {
        stageKey: '9',
        pbTotal: 20,
        pbSpent: 10,
        forca: 2,
        velocidade: 2,
        agilidade: 2,
        resistencia: 2,
        poderMagico: 7,
        status: 'confirmed',
        pending: null,
        confirmedAt: '2026-08-01 12:00:00',
        ...overrides,
    };
    await db.run(
        `INSERT INTO clover_character_stats
         (player_id, stage_key, pb_total, pb_spent, forca, velocidade, agilidade,
          resistencia, poder_magico, distribution_status, pending_distribution_json,
          confirmed_at, updated_at)
         VALUES ('player@test', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-08-01 12:00:00')`,
        [
            row.stageKey, row.pbTotal, row.pbSpent, row.forca, row.velocidade,
            row.agilidade, row.resistencia, row.poderMagico, row.status,
            row.pending ? JSON.stringify(row.pending) : null, row.confirmedAt,
        ]
    );
    return db;
}

const operation = {
    code: 'OP-A1B2C3',
    reason: 'Correção de progressão',
    actor: { id: 'admin@test', role: 'owner' },
};
const target = { playerId: 'player@test', characterName: 'Teste' };
const unit = { id: 'U1', target_player_id: target.playerId, metadata: { target } };

test('PB allocation derives base PM separately from external PM bonus', () => {
    const stats = {
        pb_spent: 10,
        forca: 2,
        velocidade: 2,
        agilidade: 2,
        resistencia: 2,
        poder_magico: 7,
    };
    const result = deriveAllocatedAttributes(stats);
    assert.deepEqual(result.allocated, {
        forca: 2,
        velocidade: 2,
        agilidade: 2,
        resistencia: 2,
        poder_magico: 2,
    });
    assert.equal(result.pmExternalDelta, 5);
    assert.equal(result.effective.poder_magico, 7);
});

test('normalization enforces full final allocation, PB budget and per-attribute cap', () => {
    const before = { pbTotal: 20 };
    const ok = normalizeFinalAllocation({
        attributes: { forca: 3, velocidade: 2, agilidade: 2, resistencia: 2, poder_magico: 3 },
    }, before);
    assert.equal(ok.used, 12);
    assert.equal(ok.free, 8);

    assert.throws(
        () => normalizeFinalAllocation({ attributes: { forca: 3, velocidade: 2 } }, before),
        (error) => error instanceof AdminProgressionError && error.code === 'missing_attribute_value'
    );
    assert.throws(
        () => normalizeFinalAllocation({
            attributes: { forca: 11, velocidade: 2, agilidade: 2, resistencia: 2, poder_magico: 2 },
        }, before),
        (error) => error instanceof AdminProgressionError && error.code === 'attribute_limit_exceeded'
    );
    assert.throws(
        () => normalizeFinalAllocation({
            attributes: { forca: 5, velocidade: 5, agilidade: 5, resistencia: 5, poder_magico: 5 },
        }, before),
        (error) => error instanceof AdminProgressionError && error.code === 'attribute_budget_exceeded'
    );
});

test('admin operation contract and registry expose attribute correction as non-atomic player.manage action', () => {
    const normalized = normalizeAdminOperationInput({
        title: 'Corrigir atributos',
        reason: 'Teste',
        targets: [{ kind: 'player', playerId: target.playerId }],
        actions: [{
            type: 'player.attributes.correct',
            payload: { attributes: { forca: 2, velocidade: 2, agilidade: 2, resistencia: 2, poder_magico: 2 } },
        }],
        idempotencyKey: 'progression:test',
    }, { actorId: 'admin@test', actorRole: 'owner' });
    assert.equal(normalized.actions[0].type, 'player.attributes.correct');
    assert.deepEqual(requiredCapabilitiesForActions(normalized.actions), ['player.manage']);
    const executor = getAdminOperationExecutors()['player.attributes.correct'];
    assert.ok(executor);
    assert.equal(executor.atomicSafe, false);
});

test('pending distribution must be explicitly cleared by admin correction', async (t) => {
    const db = await makeDb({
        status: 'pending_confirmation',
        pending: { forca: 3, velocidade: 2, agilidade: 2, resistencia: 2, poder_magico: 2 },
    });
    t.after(() => db.close());
    const executor = createProgressionExecutors()['player.attributes.correct'];
    await assert.rejects(
        () => executor.preview({
            db,
            operation,
            target,
            unit,
            action: {
                type: 'player.attributes.correct',
                payload: { attributes: { forca: 3, velocidade: 2, agilidade: 2, resistencia: 2, poder_magico: 3 } },
            },
        }),
        (error) => error instanceof AdminProgressionError && error.code === 'attribute_distribution_pending'
    );
    const preview = await executor.preview({
        db,
        operation,
        target,
        unit,
        action: {
            type: 'player.attributes.correct',
            payload: {
                clearPending: true,
                attributes: { forca: 3, velocidade: 2, agilidade: 2, resistencia: 2, poder_magico: 3 },
            },
        },
    });
    assert.equal(preview.after.pendingDistribution, null);
    assert.equal(preview.after.distributionStatus, 'confirmed');
});

test('apply preserves external PM delta and undo restores exact progression snapshot', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const executor = getAdminOperationExecutors()['player.attributes.correct'];
    const action = {
        type: 'player.attributes.correct',
        payload: {
            attributes: { forca: 3, velocidade: 2, agilidade: 2, resistencia: 2, poder_magico: 3 },
        },
    };
    const preview = await executor.preview({ db, operation, action, target, unit });
    assert.equal(preview.before.pmExternalDelta, 5);
    assert.equal(preview.after.allocatedAttributes.poder_magico, 3);
    assert.equal(preview.after.effectiveAttributes.poder_magico, 8);
    assert.equal(preview.after.pbSpent, 12);

    const applied = await executor.apply({
        db,
        operation,
        action,
        target,
        unit,
        before: preview.before,
        after: preview.after,
    });
    assert.equal(applied.after.pbSpent, 12);
    assert.equal(applied.after.allocatedAttributes.poder_magico, 3);
    assert.equal(applied.after.effectiveAttributes.poder_magico, 8);
    assert.equal(applied.after.pmExternalDelta, 5);

    const row = await db.get(
        'SELECT pb_spent, forca, velocidade, agilidade, resistencia, poder_magico FROM clover_character_stats WHERE player_id = ?',
        [target.playerId]
    );
    assert.equal(row.pb_spent, 12);
    assert.equal(row.poder_magico, 8);

    await executor.undo({
        db,
        operation,
        action,
        target,
        unit,
        before: preview.before,
        after: applied.after,
    });
    const restored = progressionSnapshot(await db.get('SELECT * FROM clover_character_stats WHERE player_id = ?', [target.playerId]));
    assert.equal(restored.pbSpent, 10);
    assert.equal(restored.allocatedAttributes.poder_magico, 2);
    assert.equal(restored.effectiveAttributes.poder_magico, 7);
    assert.equal(restored.pmExternalDelta, 5);
});

test('apply fails closed when progression changes after preview', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const executor = createProgressionExecutors()['player.attributes.correct'];
    const action = {
        type: 'player.attributes.correct',
        payload: { attributes: { forca: 3, velocidade: 2, agilidade: 2, resistencia: 2, poder_magico: 3 } },
    };
    const preview = await executor.preview({ db, operation, action, target, unit });
    await db.run('UPDATE clover_character_stats SET forca = 4, pb_spent = 12 WHERE player_id = ?', [target.playerId]);
    await assert.rejects(
        () => executor.apply({ db, operation, action, target, unit, before: preview.before, after: preview.after }),
        (error) => error instanceof AdminProgressionError && error.code === 'progression_changed_after_preview'
    );
});
