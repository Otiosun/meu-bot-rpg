'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    cancelSpellReviewExternalJobs,
    claimNextSpellReviewExternalJob,
    completeSpellReviewExternalJob,
    enqueueSpellReviewExternalJob,
    failSpellReviewExternalJob,
    listSpellReviewExternalJobs,
} = require('../helpers/clover/spellReviewExternalJobService');

async function makeDb() {
    return open({ filename: ':memory:', driver: sqlite3.Database });
}

test('enqueue is idempotent by job_key', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const first = await enqueueSpellReviewExternalJob(db, { key: 'job:1', type: 'fill_capacity', metadata: { source: 'test' } });
    const second = await enqueueSpellReviewExternalJob(db, { key: 'job:1', type: 'fill_capacity', metadata: { source: 'other' } });
    assert.equal(first.id, second.id);
    const rows = await db.all('SELECT * FROM clover_spell_review_external_jobs');
    assert.equal(rows.length, 1);
});

test('claim, fail, retry and complete preserve durable state', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await enqueueSpellReviewExternalJob(db, { key: 'job:retry', type: 'invite_player', playerId: 'player@test' });
    const firstClaim = await claimNextSpellReviewExternalJob(db);
    assert.equal(firstClaim.status, 'running');
    assert.equal(firstClaim.attempts, 1);

    const failed = await failSpellReviewExternalJob(db, firstClaim.id, new Error('private transport detail'));
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts, 1);
    await db.run('UPDATE clover_spell_review_external_jobs SET available_at = CURRENT_TIMESTAMP WHERE id = ?', [firstClaim.id]);

    const secondClaim = await claimNextSpellReviewExternalJob(db);
    assert.equal(secondClaim.id, firstClaim.id);
    assert.equal(secondClaim.attempts, 2);
    const done = await completeSpellReviewExternalJob(db, secondClaim.id, { ok: true });
    assert.equal(done.status, 'done');
    assert.equal(done.lastError, null);
    assert.deepEqual(done.metadata.result, { ok: true });
});

test('stale running claim is recovered and reclaimed', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const job = await enqueueSpellReviewExternalJob(db, { key: 'job:stale', type: 'fill_capacity' });
    await db.run(
        `UPDATE clover_spell_review_external_jobs
         SET status = 'running', attempts = 1, claimed_at = datetime(CURRENT_TIMESTAMP, '-10 minutes')
         WHERE id = ?`,
        [job.id]
    );
    const reclaimed = await claimNextSpellReviewExternalJob(db);
    assert.equal(reclaimed.id, job.id);
    assert.equal(reclaimed.status, 'running');
    assert.equal(reclaimed.attempts, 2);
});

test('pending job can be cancelled but started or completed job blocks cancellation', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const pending = await enqueueSpellReviewExternalJob(db, { key: 'job:cancel', type: 'fill_capacity' });
    const cancelled = await cancelSpellReviewExternalJobs(db, [pending.id]);
    assert.equal(cancelled[0].status, 'cancelled');

    const runningSeed = await enqueueSpellReviewExternalJob(db, { key: 'job:running', type: 'fill_capacity' });
    const running = await claimNextSpellReviewExternalJob(db);
    assert.equal(running.id, runningSeed.id);
    await assert.rejects(
        () => cancelSpellReviewExternalJobs(db, [running.id]),
        (error) => error?.code === 'spell_external_effect_already_started'
    );

    await completeSpellReviewExternalJob(db, running.id, { ok: true });
    await assert.rejects(
        () => cancelSpellReviewExternalJobs(db, [running.id]),
        (error) => error?.code === 'spell_external_effect_already_started'
    );
});

test('open list keeps technical error internal to service consumer', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await enqueueSpellReviewExternalJob(db, { key: 'job:error', type: 'invite_player', playerId: 'sensitive@test' });
    const claimed = await claimNextSpellReviewExternalJob(db);
    await failSpellReviewExternalJob(db, claimed.id, new Error('jid:551199999999@s.whatsapp.net transport secret'));
    const jobs = await listSpellReviewExternalJobs(db, { statuses: ['failed'] });
    assert.match(jobs[0].lastError, /551199999999/);
    // A sanitização para UI é responsabilidade do Command Center; o dado técnico permanece apenas no backend.
});
