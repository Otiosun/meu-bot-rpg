'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const { runCloverSchemaMigrations, tableExists } = require('../helpers/clover/schemaMigrationService');
const {
    RAID_REWARD_PROPOSAL_BASE_OBJECTS,
    RAID_REWARD_PROPOSAL_HISTORY_KEY,
    RAID_REWARD_PROPOSAL_HISTORY_MIGRATION,
    RAID_REWARD_PROPOSAL_HISTORY_OBJECTS,
    RAID_REWARD_PROPOSAL_HISTORY_VERSION,
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS,
    RAID_REWARD_PROPOSAL_LEGACY_BASE_TABLES,
    inspectRaidRewardProposalHistorySchemaState,
} = require('../helpers/clover/schemaMigrationCatalog');

async function openTestDatabase(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0027-reward-history-'));
    const db = await openCloverDatabase({ filename: path.join(dir, 'database.sqlite') });
    t.after(async () => { await db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return db;
}

async function createObjects(db, objects) {
    for (const object of objects) await db.exec(object.sql);
}

function run0027(db) {
    return runCloverSchemaMigrations(db, { migrations: [RAID_REWARD_PROPOSAL_HISTORY_MIGRATION] });
}

test('0027 formaliza Family B completa: proposal, authors e revisions', () => {
    assert.equal(RAID_REWARD_PROPOSAL_HISTORY_VERSION, 27);
    assert.equal(RAID_REWARD_PROPOSAL_HISTORY_KEY, '0027_raid_reward_proposal_history');
    assert.equal(RAID_REWARD_PROPOSAL_BASE_OBJECTS.length, 3);
    assert.equal(RAID_REWARD_PROPOSAL_HISTORY_OBJECTS.filter((item) => item.type === 'table').length, 2);
    assert.equal(RAID_REWARD_PROPOSAL_HISTORY_OBJECTS.filter((item) => item.type === 'index').length, 3);
    assert.equal(RAID_REWARD_PROPOSAL_HISTORY_OBJECTS.filter((item) => item.type === 'trigger').length, 7);
});

test('0027 cria Family B fresca e deixa Family C ausente', async (t) => {
    const db = await openTestDatabase(t);
    const result = await run0027(db);
    const state = await inspectRaidRewardProposalHistorySchemaState(db);
    assert.equal(result.latestVersion, 27);
    assert.equal(state.base.kind, 'exact');
    assert.equal(state.history.kind, 'exact');
    assert.equal(state.idempotency.kind, 'absent');
    assert.equal(await tableExists(db, 'clover_raid_reward_review_intents'), false);
});

test('0027 reconhece predecessor pre-snapshot e completa somente as tres colunas historicas', async (t) => {
    const db = await openTestDatabase(t);
    await db.exec(RAID_REWARD_PROPOSAL_LEGACY_BASE_TABLES[0].sql);
    await createObjects(db, RAID_REWARD_PROPOSAL_BASE_OBJECTS.filter((entry) => entry.type === 'index'));
    await db.run(`INSERT INTO clover_raid_reward_proposals (raid_id, proposed_by, metadata_json)
        VALUES (7, 'legacy@lid', '{"stable":true}')`);

    await run0027(db);

    const state = await inspectRaidRewardProposalHistorySchemaState(db);
    const proposal = await db.get('SELECT * FROM clover_raid_reward_proposals WHERE id = 1');
    const author = await db.get('SELECT * FROM clover_raid_reward_proposal_authors WHERE proposal_id = 1');
    const revision = await db.get('SELECT * FROM clover_raid_reward_proposal_revisions WHERE proposal_id = 1');
    assert.equal(state.base.kind, 'exact');
    assert.equal(state.base.lineage, 'snapshot_columns_prefix_exact');
    assert.equal(proposal.metadata_json, '{"stable":true}');
    assert.equal(proposal.snapshot_json, null);
    assert.equal(author.first_action, 'legacy_current_proposer');
    assert.equal(revision.submission_action, 'legacy_current_snapshot');
});

test('0027 reconhece todos os prefixes exatos das tres colunas snapshot na ordem historica', async (t) => {
    for (const [index, lineage] of RAID_REWARD_PROPOSAL_LEGACY_BASE_TABLES.slice(1, 4).entries()) {
        const db = await openTestDatabase(t);
        await db.exec(lineage.sql);
        await createObjects(db, RAID_REWARD_PROPOSAL_BASE_OBJECTS.filter((entry) => entry.type === 'index'));
        await run0027(db);
        const state = await inspectRaidRewardProposalHistorySchemaState(db);
        assert.equal(state.base.kind, 'exact', `prefix ${index + 1}`);
        assert.equal(state.base.lineage, 'snapshot_columns_prefix_exact', `prefix ${index + 1}`);
    }
});

test('0027 aceita proposal current pre-governance e cria apenas o historico B ausente', async (t) => {
    const db = await openTestDatabase(t);
    await createObjects(db, RAID_REWARD_PROPOSAL_BASE_OBJECTS);
    await db.run(`INSERT INTO clover_raid_reward_proposals
        (raid_id, proposed_by, snapshot_hash) VALUES (7, 'current@lid', 'h-current')`);
    await run0027(db);
    const state = await inspectRaidRewardProposalHistorySchemaState(db);
    assert.equal(state.base.lineage, 'current_proposal_pre_governance');
    assert.equal((await db.get('SELECT first_action FROM clover_raid_reward_proposal_authors WHERE proposal_id = 1')).first_action, 'legacy_current_proposer');
});

test('0027 aceita prefixo comprovado de authors e revisions e conserva historia existente', async (t) => {
    const db = await openTestDatabase(t);
    await createObjects(db, RAID_REWARD_PROPOSAL_BASE_OBJECTS);
    await db.run(`INSERT INTO clover_raid_reward_proposals
        (raid_id, proposed_by, snapshot_json, snapshot_hash) VALUES (7, 'author@lid', '{"v":1}', 'h1')`);
    await createObjects(db, RAID_REWARD_PROPOSAL_HISTORY_OBJECTS.slice(0, 2));
    await db.run(`INSERT INTO clover_raid_reward_proposal_authors
        (proposal_id, actor_id, first_action) VALUES (1, 'author@lid', 'legacy_current_proposer')`);
    const before = await db.all('SELECT proposal_id, actor_id, first_action FROM clover_raid_reward_proposal_authors');

    await run0027(db);

    assert.deepEqual(await db.all('SELECT proposal_id, actor_id, first_action FROM clover_raid_reward_proposal_authors'), before);
    assert.equal((await inspectRaidRewardProposalHistorySchemaState(db)).history.kind, 'exact');
});

test('0027 aceita prefixo interrompido na introducao de revisions', async (t) => {
    const db = await openTestDatabase(t);
    await createObjects(db, RAID_REWARD_PROPOSAL_BASE_OBJECTS);
    await db.run(`INSERT INTO clover_raid_reward_proposals
        (raid_id, proposed_by, snapshot_hash) VALUES (7, 'revision@lid', 'h-revision')`);
    await createObjects(db, RAID_REWARD_PROPOSAL_HISTORY_OBJECTS.slice(0, 6));
    await db.run(`INSERT INTO clover_raid_reward_proposal_authors
        (proposal_id, actor_id, first_action) VALUES (1, 'revision@lid', 'legacy_current_proposer')`);
    await db.run(`INSERT INTO clover_raid_reward_proposal_revisions
        (proposal_id, revision_number, submitted_by, submission_action, proposal_status, snapshot_hash)
        VALUES (1, 1, 'revision@lid', 'legacy_current_snapshot', 'pending', 'h-revision')`);
    await run0027(db);
    assert.equal((await inspectRaidRewardProposalHistorySchemaState(db)).history.kind, 'exact');
});

test('0027 preserva C exata quando B ja e exata', async (t) => {
    const db = await openTestDatabase(t);
    await createObjects(db, RAID_REWARD_PROPOSAL_BASE_OBJECTS);
    await createObjects(db, RAID_REWARD_PROPOSAL_HISTORY_OBJECTS);
    await createObjects(db, RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS);
    await db.run(`INSERT INTO clover_raid_reward_proposals (raid_id, proposed_by, snapshot_hash) VALUES (7, 'author@lid', 'h1')`);
    await db.run(`INSERT INTO clover_raid_reward_review_intents
        (idempotency_key, proposal_id, raid_id, actor_id, decision, fingerprint, status)
        VALUES ('preserve-c', 1, 7, 'reviewer@lid', 'approve', 'fingerprint', 'completed')`);
    const before = await db.get(`SELECT * FROM clover_raid_reward_review_intents WHERE idempotency_key = 'preserve-c'`);

    await run0027(db);

    assert.deepEqual(await db.get(`SELECT * FROM clover_raid_reward_review_intents WHERE idempotency_key = 'preserve-c'`), before);
});

test('0027 falha fechado para Family C presente sobre B parcial ou divergente', async (t) => {
    const db = await openTestDatabase(t);
    await db.exec('CREATE TABLE clover_raid_reward_proposals (id INTEGER PRIMARY KEY, raid_id INTEGER)');
    await createObjects(db, RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS);
    const before = await db.all(`SELECT name, sql FROM sqlite_schema WHERE name LIKE 'clover_raid_reward_review_%' ORDER BY name`);

    await assert.rejects(run0027(db), (error) => error?.code === 'raid_reward_proposal_history_c_mapping_required');
    assert.deepEqual(await db.all(`SELECT name, sql FROM sqlite_schema WHERE name LIKE 'clover_raid_reward_review_%' ORDER BY name`), before);
});

test('0027 falha fechado para Family C parcial mesmo sobre B exata', async (t) => {
    const db = await openTestDatabase(t);
    await createObjects(db, RAID_REWARD_PROPOSAL_BASE_OBJECTS);
    await createObjects(db, RAID_REWARD_PROPOSAL_HISTORY_OBJECTS);
    await db.exec(RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS[0].sql);
    await assert.rejects(run0027(db), (error) => error?.code === 'raid_reward_proposal_history_c_mapping_required');
});

test('0027 falha fechado para prefixo de historia fora da lineage comprovada', async (t) => {
    const db = await openTestDatabase(t);
    await createObjects(db, RAID_REWARD_PROPOSAL_BASE_OBJECTS);
    await db.exec(RAID_REWARD_PROPOSAL_HISTORY_OBJECTS[2].sql);
    await assert.rejects(run0027(db), (error) => error?.code === 'raid_reward_proposal_history_schema_mapping_required');
});
