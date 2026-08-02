'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const revisionService = require('../helpers/clover/raidRewardProposalRevisionService');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE clover_raid_reward_proposals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            proposed_by TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            proposed_at TEXT DEFAULT CURRENT_TIMESTAMP,
            reviewed_by TEXT DEFAULT NULL,
            snapshot_json TEXT DEFAULT NULL,
            snapshot_hash TEXT DEFAULT NULL,
            snapshot_version INTEGER NOT NULL DEFAULT 1
        )
    `);
    return db;
}

function snapshot(label, amount) {
    return JSON.stringify({
        raid: { key: 'raid-1', name: label },
        rewards: [{ type: 'yulls', amount }],
    });
}

test('schema retroregistra o snapshot atualmente conhecido', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const inserted = await db.run(
        `INSERT INTO clover_raid_reward_proposals
         (proposed_by, status, proposed_at, snapshot_json, snapshot_hash, snapshot_version)
         VALUES ('legacy-author@lid', 'pending', '2026-08-01 10:00:00', ?, 'hash-legacy', 3)`,
        [snapshot('Legado', 100)]
    );

    await revisionService.ensureProposalRevisionSchema(db);
    const revisions = await revisionService.readProposalRevisions(db, inserted.lastID);

    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].revisionNumber, 1);
    assert.equal(revisions[0].submissionAction, 'legacy_current_snapshot');
    assert.equal(revisions[0].submittedBy, 'legacy-author@lid');
    assert.equal(revisions[0].snapshotHash, 'hash-legacy');
    assert.equal(revisions[0].snapshotVersion, 3);
    assert.equal(revisions[0].snapshot.raid.name, 'Legado');
});

test('criação após schema produz revisão 1 automaticamente', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await revisionService.ensureProposalRevisionSchema(db);
    const inserted = await db.run(
        `INSERT INTO clover_raid_reward_proposals
         (proposed_by, status, snapshot_json, snapshot_hash, snapshot_version)
         VALUES ('author@lid', 'pending', ?, 'hash-v1', 1)`,
        [snapshot('Versão 1', 100)]
    );

    const revisions = await revisionService.readProposalRevisions(db, inserted.lastID);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].revisionNumber, 1);
    assert.equal(revisions[0].submissionAction, 'created');
    assert.equal(revisions[0].snapshotHash, 'hash-v1');
});

test('reenvio returned para pending cria revisão sequencial e preserva a anterior', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await revisionService.ensureProposalRevisionSchema(db);
    const inserted = await db.run(
        `INSERT INTO clover_raid_reward_proposals
         (proposed_by, status, snapshot_json, snapshot_hash, snapshot_version)
         VALUES ('author-a@lid', 'returned', ?, 'hash-v1', 1)`,
        [snapshot('Versão 1', 100)]
    );

    await db.run(
        `UPDATE clover_raid_reward_proposals
         SET proposed_by = 'author-b@lid',
             status = 'pending',
             proposed_at = '2026-08-02 01:00:00',
             snapshot_json = ?,
             snapshot_hash = 'hash-v2',
             snapshot_version = 2
         WHERE id = ?`,
        [snapshot('Versão 2', 250), inserted.lastID]
    );

    const revisions = await revisionService.readProposalRevisions(db, inserted.lastID);
    assert.equal(revisions.length, 2);
    assert.deepEqual(revisions.map((revision) => revision.revisionNumber), [1, 2]);
    assert.deepEqual(revisions.map((revision) => revision.snapshotHash), ['hash-v1', 'hash-v2']);
    assert.equal(revisions[0].submittedBy, 'author-a@lid');
    assert.equal(revisions[1].submittedBy, 'author-b@lid');
    assert.equal(revisions[1].submissionAction, 'resubmitted');
    assert.equal(revisions[0].snapshot.rewards[0].amount, 100);
    assert.equal(revisions[1].snapshot.rewards[0].amount, 250);
});

test('aprovação, devolução ou rejeição não cria revisão adicional', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await revisionService.ensureProposalRevisionSchema(db);
    const inserted = await db.run(
        `INSERT INTO clover_raid_reward_proposals
         (proposed_by, status, snapshot_json, snapshot_hash)
         VALUES ('author@lid', 'pending', ?, 'hash-v1')`,
        [snapshot('Versão 1', 100)]
    );

    await db.run(
        `UPDATE clover_raid_reward_proposals
         SET status = 'approved', reviewed_by = 'reviewer@lid'
         WHERE id = ?`,
        [inserted.lastID]
    );

    const revisions = await revisionService.readProposalRevisions(db, inserted.lastID);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].proposalStatus, 'pending');
});

test('revisões são imutáveis contra UPDATE e DELETE', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await revisionService.ensureProposalRevisionSchema(db);
    const inserted = await db.run(
        `INSERT INTO clover_raid_reward_proposals
         (proposed_by, status, snapshot_json, snapshot_hash)
         VALUES ('author@lid', 'pending', ?, 'hash-v1')`,
        [snapshot('Versão 1', 100)]
    );

    await assert.rejects(
        () => db.run(
            `UPDATE clover_raid_reward_proposal_revisions
             SET snapshot_hash = 'tampered'
             WHERE proposal_id = ? AND revision_number = 1`,
            [inserted.lastID]
        ),
        (error) => String(error?.message || '').includes('proposal_revision_immutable')
    );

    await assert.rejects(
        () => db.run(
            `DELETE FROM clover_raid_reward_proposal_revisions
             WHERE proposal_id = ? AND revision_number = 1`,
            [inserted.lastID]
        ),
        (error) => String(error?.message || '').includes('proposal_revision_immutable')
    );
});

test('sumário aponta a revisão corrente e o último reenviador', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await revisionService.ensureProposalRevisionSchema(db);
    const inserted = await db.run(
        `INSERT INTO clover_raid_reward_proposals
         (proposed_by, status, snapshot_json, snapshot_hash)
         VALUES ('author-a@lid', 'returned', ?, 'hash-v1')`,
        [snapshot('Versão 1', 100)]
    );
    await db.run(
        `UPDATE clover_raid_reward_proposals
         SET proposed_by = 'author-b@lid', status = 'pending',
             snapshot_json = ?, snapshot_hash = 'hash-v2'
         WHERE id = ?`,
        [snapshot('Versão 2', 200), inserted.lastID]
    );

    const summary = await revisionService.getProposalRevisionSummary(db, inserted.lastID);
    assert.equal(summary.revisionCount, 2);
    assert.equal(summary.currentRevision, 2);
    assert.equal(summary.currentRevisionHash, 'hash-v2');
    assert.equal(summary.lastSubmittedBy, 'author-b@lid');
});
