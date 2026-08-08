'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { ensureCloverEconomySchema } = require('../database');
const { ensureSpellbookSchema, normalizeSpellName } = require('../helpers/clover/spellbookService');
const { ensureSpellReviewFlowSchema } = require('../helpers/clover/spellReviewFlowService');
const { createSpellExecutorsForRegistry } = require('../helpers/clover/adminSpellExecutorAdapter');
const { createSystemSpellReviewExecutors } = require('../helpers/clover/adminSystemSpellReviewService');
const {
    claimNextSpellReviewExternalJob,
    failSpellReviewExternalJob,
    listSpellReviewExternalJobs,
} = require('../helpers/clover/spellReviewExternalJobService');
const { readSpellReviewExternalItems } = require('../helpers/clover/adminCommandCenterServiceV2');

const PLAYER = 'player@test';
const target = { playerId: PLAYER, characterName: 'Teste' };
const operation = { code: 'OP-SPELL-EXT', reason: 'Teste externo', actor: { id: 'admin@test', role: 'owner' } };

async function makeDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await ensureCloverEconomySchema(db);
    await ensureSpellbookSchema(db);
    await ensureSpellReviewFlowSchema(db);
    return db;
}

async function calledQueue(db) {
    await db.run(
        `INSERT INTO clover_spell_review_queue
         (player_id, status, requested_at, called_at, review_state)
         VALUES (?, 'called', '2026-08-08 01:00:00', '2026-08-08 01:05:00', 'active')`,
        [PLAYER]
    );
}

function approveAction() {
    return {
        type: 'player.spell.approve',
        payload: {
            mode: 'add',
            spell: {
                name: 'Lança Astral',
                type: 'Criação',
                cost: '10 PM',
                reach: '20 m',
                duration: 'Instantâneo',
                effect: 'Cria uma lança astral.',
                limits: 'Uma por ação.',
                admNotes: '-',
            },
        },
    };
}

test('admin spell approval registers recoverable external jobs and undo cancels them while pending', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await calledQueue(db);
    const executor = createSpellExecutorsForRegistry()['player.spell.approve'];
    const action = approveAction();
    const preview = await executor.preview({ db, operation, action, target });
    const applied = await executor.apply({ db, operation, action, target, before: preview.before, after: preview.after });

    assert.equal(applied.after.externalJobs.length, 2);
    assert.deepEqual(applied.after.externalJobs.map((job) => job.type).sort(), ['fill_capacity', 'remove_participant']);
    const jobsBeforeUndo = await listSpellReviewExternalJobs(db, { statuses: ['pending'] });
    assert.equal(jobsBeforeUndo.length, 2);

    await executor.undo({ db, operation, action, target, before: preview.before, after: applied.after });
    const jobs = await db.all('SELECT status FROM clover_spell_review_external_jobs ORDER BY id');
    assert.deepEqual(jobs.map((row) => row.status), ['cancelled', 'cancelled']);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_spellbook_spells WHERE normalized_name = ?', [normalizeSpellName('Lança Astral')])).n, 0);
});

test('admin spell undo is blocked after an external effect starts', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await calledQueue(db);
    const executor = createSpellExecutorsForRegistry()['player.spell.approve'];
    const action = approveAction();
    const preview = await executor.preview({ db, operation: { ...operation, code: 'OP-SPELL-STARTED' }, action, target });
    const applied = await executor.apply({ db, operation: { ...operation, code: 'OP-SPELL-STARTED' }, action, target, before: preview.before, after: preview.after });
    const claimed = await claimNextSpellReviewExternalJob(db);
    assert.equal(claimed.status, 'running');

    await assert.rejects(
        () => executor.undo({ db, operation, action, target, before: preview.before, after: applied.after }),
        (error) => error?.code === 'spell_external_effect_already_started'
    );
});

test('manual fill request creates a durable job and can be undone before processing', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await db.run(
        `INSERT INTO clover_spell_review_queue
         (player_id, status, requested_at, review_state)
         VALUES ('waiting@test', 'waiting', '2026-08-08 01:00:00', 'active')`
    );
    const executor = createSystemSpellReviewExecutors()['system.spell_review.fill.request'];
    const systemTarget = { kind: 'system', systemKey: 'clover', label: 'Clover RPG' };
    const fillOperation = { ...operation, code: 'OP-SPELL-FILL' };
    const preview = await executor.preview({ db, operation: fillOperation, action: { payload: {} }, target: systemTarget });
    assert.ok(preview.after.maximumCalls >= 1);
    const applied = await executor.apply({ db, operation: fillOperation, action: { payload: {} }, target: systemTarget, before: preview.before, after: preview.after });
    assert.equal(applied.after.job.type, 'fill_capacity');
    assert.equal(applied.after.job.status, 'pending');

    await executor.undo({ db, operation: fillOperation, target: systemTarget, before: preview.before, after: applied.after });
    const row = await db.get('SELECT status FROM clover_spell_review_external_jobs WHERE id = ?', [applied.after.job.id]);
    assert.equal(row.status, 'cancelled');
});

test('Command Center sanitizes technical transport errors from external jobs', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const executor = createSystemSpellReviewExecutors()['system.spell_review.fill.request'];
    await db.run(`INSERT INTO clover_spell_review_queue (player_id, status, requested_at, review_state) VALUES ('waiting@test', 'waiting', CURRENT_TIMESTAMP, 'active')`);
    const systemTarget = { kind: 'system', systemKey: 'clover' };
    const preview = await executor.preview({ db, operation: { ...operation, code: 'OP-SANITIZE' }, action: { payload: {} }, target: systemTarget });
    const applied = await executor.apply({ db, operation: { ...operation, code: 'OP-SANITIZE' }, action: { payload: {} }, target: systemTarget, before: preview.before, after: preview.after });
    const claimed = await claimNextSpellReviewExternalJob(db);
    assert.equal(claimed.id, applied.after.job.id);
    await failSpellReviewExternalJob(db, claimed.id, new Error('jid:551199999999@s.whatsapp.net token=secret'));

    const items = await readSpellReviewExternalItems(db);
    assert.equal(items.length, 1);
    const visible = JSON.stringify(items[0]);
    assert.doesNotMatch(visible, /551199999999/);
    assert.doesNotMatch(visible, /whatsapp\.net/);
    assert.doesNotMatch(visible, /token=secret/);
    assert.match(items[0].summary, /nova tentativa/i);
});
