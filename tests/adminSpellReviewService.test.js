'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { ensureSpellReviewFlowSchema, setSpellReviewCapacity } = require('../helpers/clover/spellReviewFlowService');
const {
    AdminSpellReviewError,
    createSpellReviewExecutors,
} = require('../helpers/clover/adminSpellReviewService');
const {
    normalizeAdminOperationInput,
    requiredCapabilitiesForActions,
} = require('../helpers/clover/adminOperationContract');
const { getAdminOperationExecutors } = require('../helpers/clover/adminOperationRegistry');
const { visibleInbox } = require('../helpers/clover/adminCommandCenterHttp');
const {
    spellReviewPriority,
    spellReviewSummary,
} = require('../helpers/clover/adminCommandCenterServiceV2');

const PLAYER_A = 'player-a@test';
const PLAYER_B = 'player-b@test';
const operation = {
    code: 'OP-SPELL-REVIEW',
    reason: 'Ajuste da fila de avaliação',
    actor: { id: 'admin@test', role: 'owner' },
};

async function makeDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await ensureSpellReviewFlowSchema(db);
    return db;
}

async function insertQueue(db, playerId, options = {}) {
    const status = options.status || 'called';
    const reviewState = options.reviewState || 'active';
    const result = await db.run(
        `INSERT INTO clover_spell_review_queue
         (player_id, status, requested_at, called_at, review_state, held_at, held_by, hold_reason, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            playerId,
            status,
            options.requestedAt || '2026-08-08 01:00:00',
            status === 'called' ? (options.calledAt || '2026-08-08 01:05:00') : null,
            reviewState,
            reviewState === 'pending' ? (options.heldAt || '2026-08-08 01:10:00') : null,
            reviewState === 'pending' ? (options.heldBy || 'admin-old@test') : null,
            reviewState === 'pending' ? (options.holdReason || 'aguardar jogador') : null,
            options.reason || null,
        ]
    );
    return db.get('SELECT * FROM clover_spell_review_queue WHERE id = ?', [result.lastID]);
}

function context(db, type, playerId = PLAYER_A, payload = {}) {
    return {
        db,
        operation,
        action: { type, payload },
        target: { playerId, characterName: playerId === PLAYER_A ? 'Aster' : 'Beryl' },
        unit: { id: 'U-1', target_player_id: playerId },
    };
}

test('spell review queue actions are first-class player.manage operations', () => {
    const actions = [
        { type: 'player.spell.review.hold', payload: {} },
        { type: 'player.spell.review.defer', payload: {} },
        { type: 'player.spell.review.resume', payload: {} },
    ];
    const normalized = normalizeAdminOperationInput({
        title: 'Ajustar fila de feitiços',
        reason: 'Teste',
        targets: [{ kind: 'player', playerId: PLAYER_A }],
        actions,
        idempotencyKey: 'spell-review:test',
    }, { actorId: 'admin@test', actorRole: 'owner' });

    assert.deepEqual(normalized.actions.map((item) => item.type), actions.map((item) => item.type));
    assert.deepEqual(requiredCapabilitiesForActions(normalized.actions), ['player.manage']);
    const registry = getAdminOperationExecutors();
    for (const action of actions) {
        assert.ok(registry[action.type]);
        assert.equal(registry[action.type].atomicSafe, false);
    }
});

test('hold performs preview, apply and exact undo', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await insertQueue(db, PLAYER_A, { status: 'called' });
    const executor = createSpellReviewExecutors()['player.spell.review.hold'];
    const ctx = context(db, 'player.spell.review.hold', PLAYER_A, { reason: 'Jogador indisponível' });

    const preview = await executor.preview(ctx);
    assert.equal(preview.before.entry.reviewState, 'active');
    const applied = await executor.apply({ ...ctx, before: preview.before, after: preview.after });
    assert.equal(applied.after.entry.reviewState, 'pending');
    assert.equal(applied.after.entry.holdReason, 'Jogador indisponível');

    await executor.undo({ ...ctx, before: preview.before, after: applied.after });
    const restored = await db.get('SELECT * FROM clover_spell_review_queue WHERE id = ?', [preview.before.entry.id]);
    assert.equal(restored.review_state, 'active');
    assert.equal(restored.hold_reason, null);
});

test('defer sends the entry back to waiting and undo restores the called snapshot', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await insertQueue(db, PLAYER_A, { status: 'called' });
    const executor = createSpellReviewExecutors()['player.spell.review.defer'];
    const ctx = context(db, 'player.spell.review.defer', PLAYER_A, { reason: 'Avaliar mais tarde' });

    const preview = await executor.preview(ctx);
    const applied = await executor.apply({ ...ctx, before: preview.before, after: preview.after });
    assert.equal(applied.after.entry.status, 'waiting');
    assert.equal(applied.after.entry.reviewState, 'active');
    assert.equal(applied.after.entry.calledAt, null);

    await executor.undo({ ...ctx, before: preview.before, after: applied.after });
    const restored = await db.get('SELECT * FROM clover_spell_review_queue WHERE id = ?', [preview.before.entry.id]);
    assert.equal(restored.status, 'called');
    assert.equal(restored.called_at, '2026-08-08 01:05:00');
});

test('resume rechecks capacity inside the operation and has conservative undo', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await setSpellReviewCapacity(db, 1);
    await insertQueue(db, PLAYER_A, { status: 'called', reviewState: 'pending' });
    const executor = createSpellReviewExecutors()['player.spell.review.resume'];
    const ctx = context(db, 'player.spell.review.resume');

    const preview = await executor.preview(ctx);
    assert.equal(preview.before.active, 0);
    const applied = await executor.apply({ ...ctx, before: preview.before, after: preview.after });
    assert.equal(applied.after.entry.reviewState, 'active');

    await executor.undo({ ...ctx, before: preview.before, after: applied.after });
    const restored = await db.get('SELECT * FROM clover_spell_review_queue WHERE id = ?', [preview.before.entry.id]);
    assert.equal(restored.review_state, 'pending');
    assert.equal(restored.hold_reason, 'aguardar jogador');
});

test('resume is blocked if capacity becomes full after preview', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await setSpellReviewCapacity(db, 1);
    await insertQueue(db, PLAYER_A, { status: 'called', reviewState: 'pending' });
    const executor = createSpellReviewExecutors()['player.spell.review.resume'];
    const ctx = context(db, 'player.spell.review.resume');
    const preview = await executor.preview(ctx);

    await insertQueue(db, PLAYER_B, { status: 'called', reviewState: 'active' });
    await assert.rejects(
        () => executor.apply({ ...ctx, before: preview.before, after: preview.after }),
        (error) => error instanceof AdminSpellReviewError && error.code === 'spell_review_capacity_full'
    );
});

test('undo fails closed after a later queue mutation', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await insertQueue(db, PLAYER_A, { status: 'called' });
    const executor = createSpellReviewExecutors()['player.spell.review.hold'];
    const ctx = context(db, 'player.spell.review.hold');
    const preview = await executor.preview(ctx);
    const applied = await executor.apply({ ...ctx, before: preview.before, after: preview.after });

    await db.run(
        `UPDATE clover_spell_review_queue SET hold_reason = 'mudança posterior' WHERE id = ?`,
        [applied.after.entry.id]
    );
    await assert.rejects(
        () => executor.undo({ ...ctx, before: preview.before, after: applied.after }),
        (error) => error instanceof AdminSpellReviewError && error.code === 'spell_review_changed_after_apply'
    );
});

test('spell review inbox priorities distinguish broken, called, held and capacity-blocked entries', () => {
    const broken = { status: 'waiting', integrity: { blocking: [{ message: 'Cadastro ausente.' }], warnings: [] } };
    const called = { status: 'called', review_state: 'active', integrity: { blocking: [], warnings: [] } };
    const held = { status: 'called', review_state: 'pending', hold_reason: 'aguardar', integrity: { blocking: [], warnings: [] } };
    const waitingBlocked = { status: 'waiting', position: 3, integrity: { blocking: [], warnings: [] } };

    assert.equal(spellReviewPriority(broken, null), 'critical');
    assert.equal(spellReviewPriority(called, { canApproveNewSpell: true }), 'high');
    assert.equal(spellReviewPriority(held, { canApproveNewSpell: true }), 'medium');
    assert.equal(spellReviewPriority(waitingBlocked, { canApproveNewSpell: false, overCapacity: false }), 'medium');
    assert.match(spellReviewSummary(held, null), /suspensa/i);
    assert.match(spellReviewSummary(waitingBlocked, { canApproveNewSpell: false, overCapacity: false }), /slot/i);
});

test('Inbox exposes spell reviews only to profiles with player.view', () => {
    const payload = {
        ok: true,
        readOnly: true,
        summary: {},
        items: [
            { id: 'spell-review:1', category: 'spell_review', priority: 'high', status: 'called' },
            { id: 'operation:X', category: 'operation', priority: 'critical', status: 'failed' },
        ],
        sections: {
            operations: [],
            raidRewardProposals: [],
            adminRoleChanges: [],
            starAnomalies: [],
            spellReviews: [{ id: 'spell-review:1' }],
            spellReviewFlow: { capacity: 5, active: 1, pending: 0, waiting: 0, vacancies: 4, autoFlow: true },
            integrity: null,
        },
    };

    const playerViewer = visibleInbox(payload, { actor: { role: 'assistant', capabilities: ['player.view'] } });
    assert.deepEqual(playerViewer.items.map((item) => item.category), ['spell_review']);
    assert.equal(playerViewer.summary.spellReviews, 1);
    assert.equal(playerViewer.sections.spellReviews.length, 1);

    const operationViewer = visibleInbox(payload, { actor: { role: 'assistant', capabilities: ['operation.view'] } });
    assert.deepEqual(operationViewer.items.map((item) => item.category), ['operation']);
    assert.equal(operationViewer.summary.spellReviews, 0);
    assert.deepEqual(operationViewer.sections.spellReviews, []);
});
