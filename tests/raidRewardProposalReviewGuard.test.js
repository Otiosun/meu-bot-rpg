'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    strictReviewContextTriggerSql,
} = require('../helpers/clover/raidRewardProposalReviewGuardService');

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE clover_raid_reward_proposals (
            id INTEGER PRIMARY KEY,
            raid_id INTEGER NOT NULL,
            status TEXT NOT NULL,
            reviewed_by TEXT DEFAULT NULL,
            review_note TEXT DEFAULT NULL,
            snapshot_hash TEXT DEFAULT NULL
        );
        CREATE TABLE clover_raid_reward_review_intents (
            idempotency_key TEXT PRIMARY KEY,
            proposal_id INTEGER NOT NULL,
            raid_id INTEGER NOT NULL,
            actor_id TEXT NOT NULL,
            decision TEXT NOT NULL,
            review_note TEXT DEFAULT NULL,
            fingerprint TEXT NOT NULL,
            expected_snapshot_hash TEXT DEFAULT NULL,
            status TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await db.exec(strictReviewContextTriggerSql());
    return db;
}

async function seed(db, intent = {}) {
    await db.run(
        `INSERT INTO clover_raid_reward_proposals
         (id, raid_id, status, snapshot_hash)
         VALUES (1, 10, 'pending', ?)`,
        [intent.currentHash || 'hash-1']
    );
    await db.run(
        `INSERT INTO clover_raid_reward_review_intents
         (idempotency_key, proposal_id, raid_id, actor_id, decision,
          review_note, fingerprint, expected_snapshot_hash, status, updated_at)
         VALUES (?, 1, 10, 'reviewer@test', ?, ?, 'fp', ?, 'processing', ?)`,
        [
            intent.key || 'key-1',
            intent.decision || 'return',
            intent.note ?? 'corrigir',
            intent.expectedHash || 'hash-1',
            intent.updatedAt || '2026-08-07 22:00:00',
        ]
    );
}

test('proposal review guard accepts the latest matching intent', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await seed(db);

    await db.run(
        `UPDATE clover_raid_reward_proposals
         SET status = 'returned', reviewed_by = 'reviewer@test', review_note = 'corrigir'
         WHERE id = 1`
    );
    const row = await db.get('SELECT status, review_note FROM clover_raid_reward_proposals WHERE id = 1');
    assert.equal(row.status, 'returned');
    assert.equal(row.review_note, 'corrigir');
});

test('proposal review guard blocks a different note from consuming the intent', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await seed(db);

    await assert.rejects(
        () => db.run(
            `UPDATE clover_raid_reward_proposals
             SET status = 'returned', reviewed_by = 'reviewer@test', review_note = 'outra nota'
             WHERE id = 1`
        ),
        /raid_reward_review_context_mismatch/
    );
});

test('proposal review guard blocks an intent from an older proposal snapshot', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await seed(db, { expectedHash: 'hash-antigo', currentHash: 'hash-novo' });

    await assert.rejects(
        () => db.run(
            `UPDATE clover_raid_reward_proposals
             SET status = 'returned', reviewed_by = 'reviewer@test', review_note = 'corrigir'
             WHERE id = 1`
        ),
        /raid_reward_review_context_mismatch/
    );
});

test('proposal review guard uses the newest processing intent for the reviewer', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await seed(db, {
        key: 'old-key',
        note: 'antiga',
        expectedHash: 'hash-antigo',
        currentHash: 'hash-novo',
        updatedAt: '2026-08-07 22:00:00',
    });
    await db.run(
        `INSERT INTO clover_raid_reward_review_intents
         (idempotency_key, proposal_id, raid_id, actor_id, decision,
          review_note, fingerprint, expected_snapshot_hash, status, updated_at)
         VALUES ('new-key', 1, 10, 'reviewer@test', 'return',
                 'nova', 'fp-new', 'hash-novo', 'processing', '2026-08-07 22:05:00')`
    );

    await db.run(
        `UPDATE clover_raid_reward_proposals
         SET status = 'returned', reviewed_by = 'reviewer@test', review_note = 'nova'
         WHERE id = 1`
    );
    const row = await db.get('SELECT status, review_note FROM clover_raid_reward_proposals WHERE id = 1');
    assert.equal(row.status, 'returned');
    assert.equal(row.review_note, 'nova');
});
