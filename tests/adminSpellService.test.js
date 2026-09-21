'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { ensureCloverEconomySchema } = require('../database');
const {
    ensureSpellbookSchema,
    normalizeSpellName,
    saveSpell,
} = require('../helpers/clover/spellbookService');
const { ensureSpellReviewFlowSchema } = require('../helpers/clover/spellReviewFlowService');
const {
    AdminSpellError,
    readAdminPlayerSpellbook,
} = require('../helpers/clover/adminSpellService');
const {
    createSpellExecutorsForRegistry,
} = require('../helpers/clover/adminSpellExecutorAdapter');
const { getAdminOperationExecutors } = require('../helpers/clover/adminOperationRegistry');
const {
    normalizeAdminOperationInput,
    requiredCapabilitiesForActions,
} = require('../helpers/clover/adminOperationContract');
const { parseAdminSpellPath } = require('../helpers/clover/adminSpellHttp');

const PLAYER_ID = 'player@test';
const target = { playerId: PLAYER_ID, characterName: 'Teste' };
const unit = { id: 'U-SPELL', target_player_id: PLAYER_ID, metadata: { target } };
const operation = {
    code: 'OP-SPELL',
    reason: 'Revisão administrativa de feitiço',
    actor: { id: 'admin@test', role: 'owner' },
};

function sheet(name = 'Lança Solar') {
    return {
        name,
        normalizedName: normalizeSpellName(name),
        type: 'Criação',
        cost: '10 PM',
        reach: '20 m',
        duration: 'Instantâneo',
        effect: 'Cria uma lança de luz.',
        limits: 'Uma por ação.',
        admNotes: 'Aprovado em teste.',
    };
}

function action(mode = 'add', name = 'Lança Solar') {
    return {
        type: 'player.spell.approve',
        payload: {
            mode,
            spell: sheet(name),
        },
    };
}

async function makeDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await ensureCloverEconomySchema(db);
    await ensureSpellbookSchema(db);
    await ensureSpellReviewFlowSchema(db);
    return db;
}

async function queue(db, status = 'called') {
    const result = await db.run(
        `INSERT INTO clover_spell_review_queue
         (player_id, status, requested_at, called_at, review_state)
         VALUES (?, ?, '2026-08-08 01:00:00', ?, 'active')`,
        [PLAYER_ID, status, status === 'called' ? '2026-08-08 01:05:00' : null]
    );
    return db.get('SELECT * FROM clover_spell_review_queue WHERE id = ?', [result.lastID]);
}

async function seedSpell(db, name, version = 1, options = {}) {
    const data = sheet(name);
    const saved = await saveSpell(db, PLAYER_ID, { ...data, version }, 'seed-admin', {
        nextVersion: Boolean(options.nextVersion),
    });
    assert.equal(saved.ok, true);
    if (options.removed) {
        await db.run(
            `UPDATE clover_spellbook_spells
             SET status = 'removed', removed_at = '2026-08-01 12:00:00'
             WHERE id = ?`,
            [saved.spell.id]
        );
    }
    return db.get('SELECT * FROM clover_spellbook_spells WHERE id = ?', [saved.spell.id]);
}

test('spell admin actions are first-class player.manage actions and stay non-atomicSafe', () => {
    const normalized = normalizeAdminOperationInput({
        title: 'Revisar feitiço',
        reason: 'Teste',
        targets: [{ kind: 'player', playerId: PLAYER_ID }],
        actions: [action('add')],
        idempotencyKey: 'spell:test:add',
    }, { actorId: 'admin@test', actorRole: 'owner' });

    assert.equal(normalized.actions[0].type, 'player.spell.approve');
    assert.deepEqual(requiredCapabilitiesForActions(normalized.actions), ['player.manage']);
    const registry = getAdminOperationExecutors();
    assert.ok(registry['player.spell.approve']);
    assert.ok(registry['player.spell.remove']);
    assert.equal(registry['player.spell.approve'].atomicSafe, false);
    assert.equal(registry['player.spell.remove'].atomicSafe, false);
});

test('admin spell route parser accepts only player spellbook endpoint', () => {
    assert.deepEqual(parseAdminSpellPath('/admin/players/player%40test/spells'), { playerId: PLAYER_ID });
    assert.equal(parseAdminSpellPath('/admin/players/player%40test/spells/1'), null);
    assert.equal(parseAdminSpellPath('/players/player%40test/spells'), null);
});

test('read model exposes approved spells, versions, capacity and active review', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await seedSpell(db, 'Escudo Astral');
    await queue(db, 'waiting');

    const view = await readAdminPlayerSpellbook(db, PLAYER_ID);
    assert.equal(view.ok, true);
    assert.equal(view.totalApproved, 1);
    assert.equal(view.approved[0].name, 'Escudo Astral');
    assert.equal(view.versions.length, 1);
    assert.equal(view.capacity.totalSlots, 1);
    assert.equal(view.capacity.availableSlots, 0);
    assert.equal(view.review.status, 'waiting');
    assert.equal(view.review.position, 1);
});

test('add approval performs preview, apply and conservative undo', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const originalQueue = await queue(db, 'called');
    const executor = createSpellExecutorsForRegistry()['player.spell.approve'];
    const spellAction = action('add');

    const preview = await executor.preview({ db, operation, action: spellAction, target, unit });
    assert.equal(preview.before.mode, 'add');
    assert.equal(preview.before.versions.length, 0);
    assert.equal(preview.after.spell.version, 1);

    const applied = await executor.apply({
        db,
        operation,
        action: spellAction,
        target,
        unit,
        before: preview.before,
        after: preview.after,
    });
    assert.equal(applied.after.spell.version, 1);
    assert.equal(applied.after.queue.status, 'concluded');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_spellbook_spells')).n, 1);

    await executor.undo({
        db,
        operation,
        action: spellAction,
        target,
        unit,
        before: preview.before,
        after: applied.after,
    });
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_spellbook_spells')).n, 0);
    const restoredQueue = await db.get('SELECT * FROM clover_spell_review_queue WHERE id = ?', [originalQueue.id]);
    assert.equal(restoredQueue.status, 'called');
    assert.equal(restoredQueue.closed_at, null);
});

test('waiting review cannot approve a spell', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await queue(db, 'waiting');
    const executor = createSpellExecutorsForRegistry()['player.spell.approve'];

    await assert.rejects(
        () => executor.preview({ db, operation, action: action('add'), target, unit }),
        (error) => error instanceof AdminSpellError && error.code === 'queue_entry_not_called'
    );
});

test('add rejects a name that already has version history', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await seedSpell(db, 'Eco Lunar');
    await queue(db, 'called');
    const executor = createSpellExecutorsForRegistry()['player.spell.approve'];

    await assert.rejects(
        () => executor.preview({ db, operation, action: action('add', 'Eco Lunar'), target, unit }),
        (error) => error instanceof AdminSpellError && error.code === 'spell_add_requires_new_name'
    );
});

test('update requires version history and creates the next version without consuming a new slot', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await queue(db, 'called');
    const executor = createSpellExecutorsForRegistry()['player.spell.approve'];

    await assert.rejects(
        () => executor.preview({ db, operation, action: action('update', 'Eco Lunar'), target, unit }),
        (error) => error instanceof AdminSpellError && error.code === 'spell_update_requires_existing'
    );

    await seedSpell(db, 'Eco Lunar');
    const updateAction = action('update', 'Eco Lunar');
    const preview = await executor.preview({ db, operation, action: updateAction, target, unit });
    assert.equal(preview.after.spell.version, 2);
    assert.equal(preview.before.capacity.availableSlots, 0);

    const applied = await executor.apply({
        db,
        operation,
        action: updateAction,
        target,
        unit,
        before: preview.before,
        after: preview.after,
    });
    assert.equal(applied.after.spell.version, 2);
    const versions = await db.all(
        'SELECT version, status FROM clover_spellbook_spells WHERE player_id = ? AND normalized_name = ? ORDER BY version',
        [PLAYER_ID, normalizeSpellName('Eco Lunar')]
    );
    assert.deepEqual(versions.map((row) => row.version), [1, 2]);
});

test('new spell approval is blocked when personal capacity is full', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await seedSpell(db, 'Primeiro Feitiço');
    await queue(db, 'called');
    const executor = createSpellExecutorsForRegistry()['player.spell.approve'];

    await assert.rejects(
        () => executor.preview({ db, operation, action: action('add', 'Segundo Feitiço'), target, unit }),
        (error) => error instanceof AdminSpellError && error.code === 'spell_capacity_full'
    );
});

test('apply fails closed if spell history changes after preview', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await queue(db, 'called');
    const executor = createSpellExecutorsForRegistry()['player.spell.approve'];
    const spellAction = action('add', 'Pulso Arcano');
    const preview = await executor.preview({ db, operation, action: spellAction, target, unit });
    await seedSpell(db, 'Pulso Arcano');

    await assert.rejects(
        () => executor.apply({
            db,
            operation,
            action: spellAction,
            target,
            unit,
            before: preview.before,
            after: preview.after,
        }),
        (error) => error instanceof AdminSpellError && error.code === 'spell_versions_changed_after_preview'
    );
});

test('remove and undo touch only versions affected by the operation', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const oldRemoved = await seedSpell(db, 'Corte Vazio', 1, { removed: true });
    const active = await seedSpell(db, 'Corte Vazio', 2, { nextVersion: true });
    const executor = createSpellExecutorsForRegistry()['player.spell.remove'];
    const removeAction = { type: 'player.spell.remove', payload: { name: 'Corte Vazio' } };

    const preview = await executor.preview({ db, operation, action: removeAction, target, unit });
    assert.deepEqual(preview.before.versions.map((row) => row.id), [active.id]);

    const applied = await executor.apply({
        db,
        operation,
        action: removeAction,
        target,
        unit,
        before: preview.before,
        after: preview.after,
    });
    assert.deepEqual(applied.after.removedVersions.map((row) => row.id), [active.id]);

    await executor.undo({
        db,
        operation,
        action: removeAction,
        target,
        unit,
        before: preview.before,
        after: applied.after,
    });

    const oldRow = await db.get('SELECT status, removed_at FROM clover_spellbook_spells WHERE id = ?', [oldRemoved.id]);
    const activeRow = await db.get('SELECT status, removed_at FROM clover_spellbook_spells WHERE id = ?', [active.id]);
    assert.equal(oldRow.status, 'removed');
    assert.equal(oldRow.removed_at, '2026-08-01 12:00:00');
    assert.equal(activeRow.status, 'approved');
    assert.equal(activeRow.removed_at, null);
});
