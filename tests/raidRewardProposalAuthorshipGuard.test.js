'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const core = require('../helpers/clover/raidRewardProposalCoreService');
const service = require('../helpers/clover/raidRewardProposalService');

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
            reviewed_at TEXT DEFAULT NULL,
            snapshot_json TEXT DEFAULT NULL,
            snapshot_hash TEXT DEFAULT NULL,
            snapshot_version INTEGER NOT NULL DEFAULT 1
        )
    `);
    return db;
}

function patchCore(t, overrides = {}) {
    const original = {
        ensureRaidRewardProposalSchema: core.ensureRaidRewardProposalSchema,
        createRaidRewardProposal: core.createRaidRewardProposal,
        reviewRaidRewardProposal: core.reviewRaidRewardProposal,
        listRaidRewardProposals: core.listRaidRewardProposals,
    };
    Object.assign(core, overrides);
    t.after(() => Object.assign(core, original));
}

test('schema retroregistra proponente atual e preserva autores de reenvio', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const inserted = await db.run(
        `INSERT INTO clover_raid_reward_proposals (proposed_by, status)
         VALUES ('author-a@lid', 'returned')`
    );

    await service.ensureProposalAuthorTrackingSchema(db);
    let authors = await service.readProposalAuthorIds(db, inserted.lastID);
    assert.deepEqual(authors, ['author-a@lid']);

    const originalRow = await db.get(
        `SELECT first_action
         FROM clover_raid_reward_proposal_authors
         WHERE proposal_id = ? AND actor_id = 'author-a@lid'`,
        [inserted.lastID]
    );
    assert.equal(originalRow.first_action, 'legacy_current_proposer');

    await db.run(
        `UPDATE clover_raid_reward_proposals
         SET proposed_by = 'author-b@lid', status = 'pending'
         WHERE id = ?`,
        [inserted.lastID]
    );

    authors = await service.readProposalAuthorIds(db, inserted.lastID);
    assert.deepEqual(authors, ['author-a@lid', 'author-b@lid']);
    const resubmitter = await db.get(
        `SELECT first_action
         FROM clover_raid_reward_proposal_authors
         WHERE proposal_id = ? AND actor_id = 'author-b@lid'`,
        [inserted.lastID]
    );
    assert.equal(resubmitter.first_action, 'resubmitted');
});

test('autor original e reenviador permanecem bloqueados após troca de proposed_by', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const inserted = await db.run(
        `INSERT INTO clover_raid_reward_proposals (proposed_by, status)
         VALUES ('author-a@lid', 'returned')`
    );
    await service.ensureProposalAuthorTrackingSchema(db);
    await db.run(
        `UPDATE clover_raid_reward_proposals
         SET proposed_by = 'author-b@lid', status = 'pending'
         WHERE id = ?`,
        [inserted.lastID]
    );

    assert.equal(await service.isProposalAuthor(db, inserted.lastID, 'author-a@lid'), true);
    assert.equal(await service.isProposalAuthor(db, inserted.lastID, 'author-b@lid'), true);
    assert.equal(await service.isProposalAuthor(db, inserted.lastID, 'reviewer@lid'), false);

    await assert.rejects(
        () => service.assertReviewerNotProposalAuthor(db, inserted.lastID, 'author-a@lid'),
        (error) => error?.code === 'self_review_blocked'
    );
    await assert.rejects(
        () => service.assertReviewerNotProposalAuthor(db, inserted.lastID, 'author-b@lid'),
        (error) => error?.code === 'self_review_blocked'
    );
});

test('alias com sufixo de dispositivo é reconhecido como o mesmo autor', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const inserted = await db.run(
        `INSERT INTO clover_raid_reward_proposals (proposed_by, status)
         VALUES ('551199999999@s.whatsapp.net', 'pending')`
    );
    await service.ensureProposalAuthorTrackingSchema(db);

    assert.equal(
        await service.isProposalAuthor(
            db,
            inserted.lastID,
            '551199999999:7@s.whatsapp.net'
        ),
        true
    );
});

test('trigger bloqueia revisão direta por qualquer autor e permite terceiro', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const inserted = await db.run(
        `INSERT INTO clover_raid_reward_proposals (proposed_by, status)
         VALUES ('author-a@lid', 'returned')`
    );
    await service.ensureProposalAuthorTrackingSchema(db);
    await db.run(
        `UPDATE clover_raid_reward_proposals
         SET proposed_by = 'author-b@lid', status = 'pending'
         WHERE id = ?`,
        [inserted.lastID]
    );

    await assert.rejects(
        () => db.run(
            `UPDATE clover_raid_reward_proposals
             SET status = 'rejected', reviewed_by = 'author-a@lid'
             WHERE id = ?`,
            [inserted.lastID]
        ),
        (error) => String(error?.message || '').includes('self_review_blocked')
    );

    await assert.rejects(
        () => db.run(
            `UPDATE clover_raid_reward_proposals
             SET status = 'rejected', reviewed_by = 'author-b@lid'
             WHERE id = ?`,
            [inserted.lastID]
        ),
        (error) => String(error?.message || '').includes('self_review_blocked')
    );

    const allowed = await db.run(
        `UPDATE clover_raid_reward_proposals
         SET status = 'rejected', reviewed_by = 'reviewer@lid'
         WHERE id = ?`,
        [inserted.lastID]
    );
    assert.equal(Number(allowed.changes), 1);
});

test('fachada impede autor com cargo acumulado antes de chamar o núcleo', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const inserted = await db.run(
        `INSERT INTO clover_raid_reward_proposals (proposed_by, status)
         VALUES ('author-reviewer@lid', 'pending')`
    );
    await service.ensureProposalAuthorTrackingSchema(db);

    let coreCalls = 0;
    patchCore(t, {
        ensureRaidRewardProposalSchema: async () => null,
        reviewRaidRewardProposal: async () => {
            coreCalls += 1;
            return { ok: true };
        },
    });

    await assert.rejects(
        () => service.reviewRaidRewardProposal(db, {
            proposalId: inserted.lastID,
            actorId: 'author-reviewer@lid',
            decision: 'approve',
        }),
        (error) => error?.code === 'self_review_blocked'
    );
    assert.equal(coreCalls, 0);
});

test('fachada permite revisor externo e normaliza falha final do trigger', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const inserted = await db.run(
        `INSERT INTO clover_raid_reward_proposals (proposed_by, status)
         VALUES ('author@lid', 'pending')`
    );
    await service.ensureProposalAuthorTrackingSchema(db);

    let coreCalls = 0;
    patchCore(t, {
        ensureRaidRewardProposalSchema: async () => null,
        reviewRaidRewardProposal: async (_db, input) => {
            coreCalls += 1;
            if (input.actorId === 'trigger-author@lid') {
                throw new Error('SQLITE_CONSTRAINT: self_review_blocked');
            }
            return { ok: true, reviewer: input.actorId };
        },
    });

    const allowed = await service.reviewRaidRewardProposal(db, {
        proposalId: inserted.lastID,
        actorId: 'reviewer@lid',
        decision: 'reject',
    });
    assert.equal(allowed.ok, true);
    assert.equal(coreCalls, 1);

    await assert.rejects(
        () => service.reviewRaidRewardProposal(db, {
            proposalId: inserted.lastID,
            actorId: 'trigger-author@lid',
            decision: 'approve',
        }),
        (error) => error?.code === 'self_review_blocked'
    );
});

test('listagem remove canReview de autor histórico', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const inserted = await db.run(
        `INSERT INTO clover_raid_reward_proposals (proposed_by, status)
         VALUES ('author-a@lid', 'returned')`
    );
    await service.ensureProposalAuthorTrackingSchema(db);
    await db.run(
        `UPDATE clover_raid_reward_proposals
         SET proposed_by = 'author-b@lid', status = 'pending'
         WHERE id = ?`,
        [inserted.lastID]
    );

    patchCore(t, {
        ensureRaidRewardProposalSchema: async () => null,
        listRaidRewardProposals: async () => [{
            id: String(inserted.lastID),
            canReview: true,
            selfReviewBlocked: false,
        }],
    });

    const originalAuthorView = await service.listRaidRewardProposals(db, {
        actorId: 'author-a@lid',
    });
    assert.equal(originalAuthorView[0].canReview, false);
    assert.equal(originalAuthorView[0].selfReviewBlocked, true);

    const reviewerView = await service.listRaidRewardProposals(db, {
        actorId: 'reviewer@lid',
    });
    assert.equal(reviewerView[0].canReview, true);
    assert.equal(reviewerView[0].selfReviewBlocked, false);
});

test('criação pela fachada registra autor na mesma transação do INSERT', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    patchCore(t, {
        ensureRaidRewardProposalSchema: async () => null,
        createRaidRewardProposal: async (database, input) => {
            const inserted = await database.run(
                `INSERT INTO clover_raid_reward_proposals (proposed_by, status)
                 VALUES (?, 'pending')`,
                [input.actorId]
            );
            return { ok: true, proposal: { id: String(inserted.lastID) } };
        },
    });

    const created = await service.createRaidRewardProposal(db, {
        actorId: 'author@lid',
    });
    const authors = await service.readProposalAuthorIds(db, created.proposal.id);
    assert.deepEqual(authors, ['author@lid']);
});
