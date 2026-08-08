'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    createAdminOperation,
    simulateAdminOperation,
    approveAdminOperation,
    applyAdminOperation,
    undoAdminOperation,
} = require('../helpers/clover/adminOperationService');
const { getAdminOperationExecutors } = require('../helpers/clover/adminOperationRegistry');
const {
    AdminOperationContractError,
    normalizeAdminOperationInput,
} = require('../helpers/clover/adminOperationContract');
const {
    ensureSpellReviewFlowSchema,
    getSpellReviewAutoFlowEnabled,
    getSpellReviewCapacity,
} = require('../helpers/clover/spellReviewFlowService');

const actor = { id: 'owner@test', role: 'owner' };

async function makeDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome TEXT,
            display_name TEXT,
            ficha_status TEXT,
            jogo_status TEXT
        )
    `);
    await ensureSpellReviewFlowSchema(db);
    return db;
}

function systemDraft(payload = { capacity: 7, autoFlow: false }) {
    return {
        title: 'Configurar avaliação de feitiços',
        reason: 'Ajuste operacional da fila',
        targets: [{ kind: 'system', systemKey: 'clover' }],
        actions: [{
            type: 'system.spell_review.settings.update',
            payload,
        }],
        idempotencyKey: `system-spell-review:${payload.capacity ?? 'same'}:${String(payload.autoFlow)}`,
    };
}

test('system target is normalized without a synthetic player', () => {
    const normalized = normalizeAdminOperationInput(systemDraft(), {
        actorId: actor.id,
        actorRole: actor.role,
        now: '2026-08-08T04:00:00.000Z',
        randomBytes: () => Buffer.from('abc123', 'hex'),
    });
    assert.deepEqual(normalized.targets, [{ kind: 'system', systemKey: 'clover' }]);
    assert.equal(normalized.actions[0].type, 'system.spell_review.settings.update');
    assert.deepEqual(normalized.requiredCapabilities, ['player.manage']);
});

test('system actions reject player targets and system targets reject player actions', () => {
    assert.throws(
        () => normalizeAdminOperationInput({
            ...systemDraft(),
            targets: [{ kind: 'player', playerId: 'player@test' }],
        }, { actorId: actor.id, actorRole: actor.role }),
        (error) => error instanceof AdminOperationContractError && error.code === 'system_action_requires_system_target'
    );

    assert.throws(
        () => normalizeAdminOperationInput({
            ...systemDraft(),
            targets: [{ kind: 'system' }],
            actions: [{ type: 'player.spell.remove', payload: { name: 'Eco' } }],
        }, { actorId: actor.id, actorRole: actor.role }),
        (error) => error instanceof AdminOperationContractError && error.code === 'system_target_requires_system_action'
    );
});

test('global settings run through draft, simulation, apply and conservative undo', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const executors = getAdminOperationExecutors();

    assert.equal(await getSpellReviewCapacity(db), 5);
    assert.equal(await getSpellReviewAutoFlowEnabled(db), true);

    const created = await createAdminOperation(db, systemDraft({ capacity: 7, autoFlow: false }), actor, { executors });
    const simulated = await simulateAdminOperation(db, created.operation.code, actor, { executors });
    assert.equal(simulated.operation.preview.targetCount, 1);
    assert.equal(simulated.operation.units[0].targetKey, 'system:clover');
    assert.deepEqual(simulated.operation.units[0].metadata.target, {
        kind: 'system',
        systemKey: 'clover',
        label: 'Clover RPG',
        source: 'system',
    });

    await approveAdminOperation(db, created.operation.code, actor);
    const applied = await applyAdminOperation(db, created.operation.code, actor, { executors });
    assert.equal(applied.ok, true);
    assert.equal(await getSpellReviewCapacity(db), 7);
    assert.equal(await getSpellReviewAutoFlowEnabled(db), false);

    const undone = await undoAdminOperation(db, created.operation.code, actor, { executors });
    assert.equal(undone.ok, true);
    assert.equal(await getSpellReviewCapacity(db), 5);
    assert.equal(await getSpellReviewAutoFlowEnabled(db), true);
});

test('capacity cannot be simulated below active review count', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const executors = getAdminOperationExecutors();
    await db.run(
        `INSERT INTO clover_spell_review_queue
         (player_id, status, requested_at, called_at, review_state)
         VALUES ('a@test', 'called', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'active')`
    );
    await db.run(
        `INSERT INTO clover_spell_review_queue
         (player_id, status, requested_at, called_at, review_state)
         VALUES ('b@test', 'called', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'active')`
    );

    const created = await createAdminOperation(db, systemDraft({ capacity: 1 }), actor, { executors });
    await assert.rejects(
        () => simulateAdminOperation(db, created.operation.code, actor, { executors }),
        (error) => error?.code === 'spell_review_capacity_below_active'
    );
});

test('apply fails closed if global settings changed after preview', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const executors = getAdminOperationExecutors();
    const created = await createAdminOperation(db, systemDraft({ capacity: 8, autoFlow: false }), actor, { executors });
    await simulateAdminOperation(db, created.operation.code, actor, { executors });
    await approveAdminOperation(db, created.operation.code, actor);

    await db.run(
        `INSERT INTO clover_settings (key, value, updated_at)
         VALUES ('clover_spell_review_capacity', '6', CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = '6', updated_at = CURRENT_TIMESTAMP`
    );

    const applied = await applyAdminOperation(db, created.operation.code, actor, { executors });
    assert.equal(applied.ok, false);
    assert.equal(applied.operation.status, 'failed');
    assert.equal(applied.operation.result.failures[0].code, 'spell_review_settings_changed_after_preview');
    assert.equal(await getSpellReviewCapacity(db), 6);
    assert.equal(await getSpellReviewAutoFlowEnabled(db), true);
});
