'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const { runCloverSchemaMigrations } = require('../helpers/clover/schemaMigrationService');
const {
    RAID_REWARD_PROPOSAL_BASE_OBJECTS,
    RAID_REWARD_PROPOSAL_HISTORY_KEY,
    RAID_REWARD_PROPOSAL_HISTORY_MIGRATION,
    RAID_REWARD_PROPOSAL_HISTORY_OBJECTS,
    RAID_REWARD_PROPOSAL_HISTORY_VERSION,
    inspectRaidRewardProposalHistorySchemaState,
} = require('../helpers/clover/schemaMigrationCatalog');

async function openTestDatabase(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0028-reward-history-'));
    const db = await openCloverDatabase({ filename: path.join(dir, 'database.sqlite') });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return db;
}

async function createObjects(db, objects) {
    for (const object of objects) await db.exec(object.sql);
}

async function run0028(db) {
    return runCloverSchemaMigrations(db, { migrations: [RAID_REWARD_PROPOSAL_HISTORY_MIGRATION] });
}

test('0028 formaliza duas tabelas, tres indices e sete triggers de historico', () => {
    assert.equal(RAID_REWARD_PROPOSAL_HISTORY_VERSION, 28);
    assert.equal(RAID_REWARD_PROPOSAL_HISTORY_KEY, '0028_raid_reward_proposal_history');
    assert.equal(RAID_REWARD_PROPOSAL_HISTORY_OBJECTS.filter((item) => item.type === 'table').length, 2);
    assert.equal(RAID_REWARD_PROPOSAL_HISTORY_OBJECTS.filter((item) => item.type === 'index').length, 3);
    assert.equal(RAID_REWARD_PROPOSAL_HISTORY_OBJECTS.filter((item) => item.type === 'trigger').length, 7);
});
test('0028 retroregistra somente proponente e snapshot correntes observaveis', async (t) => {
    const db = await openTestDatabase(t);
    await createObjects(db, RAID_REWARD_PROPOSAL_BASE_OBJECTS);
    await db.run(`INSERT INTO clover_raid_reward_proposals
        (raid_id, proposed_by, status, proposed_at, snapshot_json, snapshot_hash, snapshot_version)
        VALUES (7, 'legacy-author@lid', 'returned', '2026-08-01 12:00:00', '{"v":1}', 'h1', 3)`);

    const result = await run0028(db);
    const state = await inspectRaidRewardProposalHistorySchemaState(db);
    const author = await db.get(`SELECT * FROM clover_raid_reward_proposal_authors WHERE proposal_id=1`);
    const revision = await db.get(`SELECT * FROM clover_raid_reward_proposal_revisions WHERE proposal_id=1`);

    assert.equal(result.latestVersion, 28);
    assert.equal(state.history.kind, 'exact');
    assert.equal(author.first_action, 'legacy_current_proposer');
    assert.equal(revision.submission_action, 'legacy_current_snapshot');
    assert.equal(revision.snapshot_hash, 'h1');
    assert.equal(revision.snapshot_version, 3);
});

test('0028 preserva historico exato e bloqueia mutacao de revisao', async (t) => {
    const db = await openTestDatabase(t);
    await createObjects(db, RAID_REWARD_PROPOSAL_BASE_OBJECTS);
    await createObjects(db, RAID_REWARD_PROPOSAL_HISTORY_OBJECTS.filter((item) => item.type !== 'trigger'));
    await db.run(`INSERT INTO clover_raid_reward_proposals
        (raid_id, proposed_by, status, snapshot_json, snapshot_hash) VALUES (7, 'author@lid', 'pending', '{"v":1}', 'h1')`);
    await db.run(`INSERT INTO clover_raid_reward_proposal_authors
        (proposal_id, actor_id, first_action) VALUES (1, 'author@lid', 'legacy_current_proposer')`);
    await db.run(`INSERT INTO clover_raid_reward_proposal_revisions
        (proposal_id, revision_number, submitted_by, submission_action, proposal_status, snapshot_json, snapshot_hash)
        VALUES (1, 1, 'author@lid', 'legacy_current_snapshot', 'pending', '{"v":1}', 'h1')`);
    await createObjects(db, RAID_REWARD_PROPOSAL_HISTORY_OBJECTS.filter((item) => item.type === 'trigger'));
    const beforeAuthor = await db.all('SELECT * FROM clover_raid_reward_proposal_authors');
    const beforeRevision = await db.all('SELECT * FROM clover_raid_reward_proposal_revisions');

    await run0028(db);

    assert.deepEqual(await db.all('SELECT * FROM clover_raid_reward_proposal_authors'), beforeAuthor);
    assert.deepEqual(await db.all('SELECT * FROM clover_raid_reward_proposal_revisions'), beforeRevision);
    await assert.rejects(
        () => db.run(`UPDATE clover_raid_reward_proposal_revisions SET snapshot_hash='tampered' WHERE proposal_id=1`),
        /proposal_revision_immutable/
    );
});

test('0028 falha fechado para historico parcial', async (t) => {
    const db = await openTestDatabase(t);
    await createObjects(db, RAID_REWARD_PROPOSAL_BASE_OBJECTS);
    await db.exec(RAID_REWARD_PROPOSAL_HISTORY_OBJECTS[0].sql);

    await assert.rejects(
        run0028(db),
        (error) => error?.code === 'raid_reward_proposal_history_schema_mapping_required'
    );
});

test('0028 falha fechado para base ausente ou divergente', async (t) => {
    const missing = await openTestDatabase(t);
    await assert.rejects(
        run0028(missing),
        (error) => error?.code === 'raid_reward_proposal_history_base_mapping_required'
    );

    const divergent = await openTestDatabase(t);
    await divergent.exec(`CREATE TABLE clover_raid_reward_proposals (id INTEGER PRIMARY KEY, proposed_by TEXT)`);
    await assert.rejects(
        run0028(divergent),
        (error) => error?.code === 'raid_reward_proposal_history_base_mapping_required'
    );
});

test('0028 falha fechado quando historico exato contradiz snapshot corrente', async (t) => {
    const db = await openTestDatabase(t);
    await createObjects(db, RAID_REWARD_PROPOSAL_BASE_OBJECTS);
    await createObjects(db, RAID_REWARD_PROPOSAL_HISTORY_OBJECTS.filter((item) => item.type !== 'trigger'));
    await db.run(`INSERT INTO clover_raid_reward_proposals
        (raid_id, proposed_by, status, snapshot_json, snapshot_hash) VALUES (7, 'author@lid', 'pending', '{"v":2}', 'h2')`);
    await db.run(`INSERT INTO clover_raid_reward_proposal_authors
        (proposal_id, actor_id, first_action) VALUES (1, 'author@lid', 'legacy_current_proposer')`);
    await db.run(`INSERT INTO clover_raid_reward_proposal_revisions
        (proposal_id, revision_number, submitted_by, submission_action, proposal_status, snapshot_json, snapshot_hash)
        VALUES (1, 1, 'author@lid', 'legacy_current_snapshot', 'pending', '{"v":1}', 'h1')`);
    await createObjects(db, RAID_REWARD_PROPOSAL_HISTORY_OBJECTS.filter((item) => item.type === 'trigger'));

    await assert.rejects(
        run0028(db),
        (error) => error?.code === 'raid_reward_proposal_history_state_mapping_required'
            && error?.state?.kind === 'current_revision_mismatch'
    );
});
