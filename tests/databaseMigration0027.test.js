'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openCloverDatabase, readPragmaScalar } = require('../helpers/clover/databaseConnection');
const { runCloverSchemaMigrations, tableExists } = require('../helpers/clover/schemaMigrationService');
const {
    RAID_REWARD_PROPOSAL_BASE_OBJECTS,
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY,
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_MIGRATION,
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS,
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_VERSION,
    inspectRaidRewardProposalIdempotencySchemaState,
} = require('../helpers/clover/schemaMigrationCatalog');

async function openTestDatabase(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0027-reward-proposal-'));
    const db = await openCloverDatabase({ filename: path.join(dir, 'database.sqlite') });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return db;
}

async function run0027(db) {
    return runCloverSchemaMigrations(db, { migrations: [RAID_REWARD_PROPOSAL_IDEMPOTENCY_MIGRATION] });
}

async function createObjects(db, objects) {
    for (const object of objects) await db.exec(object.sql);
}

test('0027 formaliza base e oito objetos de idempotencia de proposta', () => {
    assert.equal(RAID_REWARD_PROPOSAL_IDEMPOTENCY_VERSION, 27);
    assert.equal(RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY, '0027_raid_reward_proposal_idempotency');
    assert.equal(RAID_REWARD_PROPOSAL_BASE_OBJECTS.length, 3);
    assert.equal(RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS.length, 8);
});
test('0027 cria base e extensao vazias sem inventar propostas ou reviews', async (t) => {
    const db = await openTestDatabase(t);
    const result = await run0027(db);
    const state = await inspectRaidRewardProposalIdempotencySchemaState(db);

    assert.equal(result.latestVersion, 27);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 27);
    assert.equal(state.base.kind, 'exact');
    assert.equal(state.idempotency.kind, 'exact');
    for (const table of RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS.filter((item) => item.type === 'table')) {
        assert.equal(Number((await db.get(`SELECT COUNT(*) AS n FROM ${table.name}`)).n), 0, table.name);
    }
});

test('0027 preserva C existente quando B e C sao exatamente canonicos', async (t) => {
    const db = await openTestDatabase(t);
    await createObjects(db, RAID_REWARD_PROPOSAL_BASE_OBJECTS);
    await createObjects(db, RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS);
    await db.run(`INSERT INTO clover_raid_reward_proposals
        (raid_id, proposed_by, snapshot_hash) VALUES (7, 'author@lid', 'snapshot-1')`);
    await db.run(`INSERT INTO clover_raid_reward_review_intents
        (idempotency_key, proposal_id, raid_id, actor_id, decision, fingerprint, status)
        VALUES ('preserve-c', 1, 7, 'reviewer@lid', 'approve', 'fingerprint', 'completed')`);
    await db.run(`INSERT INTO clover_raid_reward_review_events
        (idempotency_key, proposal_id, raid_id, actor_id, decision, proposal_status, fingerprint)
        VALUES ('preserve-c', 1, 7, 'reviewer@lid', 'approve', 'delivered', 'fingerprint')`);
    const beforeIntent = await db.get(`SELECT * FROM clover_raid_reward_review_intents WHERE idempotency_key='preserve-c'`);
    const beforeEvent = await db.get(`SELECT * FROM clover_raid_reward_review_events WHERE idempotency_key='preserve-c'`);

    await run0027(db);

    assert.deepEqual(await db.get(`SELECT * FROM clover_raid_reward_review_intents WHERE idempotency_key='preserve-c'`), beforeIntent);
    assert.deepEqual(await db.get(`SELECT * FROM clover_raid_reward_review_events WHERE idempotency_key='preserve-c'`), beforeEvent);
    assert.equal((await inspectRaidRewardProposalIdempotencySchemaState(db)).idempotency.kind, 'exact');
});

test('0027 completa C ausente sobre B exata', async (t) => {
    const db = await openTestDatabase(t);
    await createObjects(db, RAID_REWARD_PROPOSAL_BASE_OBJECTS);

    await run0027(db);

    const state = await inspectRaidRewardProposalIdempotencySchemaState(db);
    assert.equal(state.base.kind, 'exact');
    assert.equal(state.idempotency.kind, 'exact');
});

test('0027 falha fechado para C parcial', async (t) => {
    const db = await openTestDatabase(t);
    await createObjects(db, RAID_REWARD_PROPOSAL_BASE_OBJECTS);
    await db.exec(RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS[0].sql);

    await assert.rejects(
        run0027(db),
        (error) => error?.code === 'raid_reward_proposal_idempotency_schema_mapping_required'
    );
    assert.equal(await tableExists(db, 'clover_raid_reward_review_intents'), true);
    assert.equal(await tableExists(db, 'clover_raid_reward_review_events'), false);
});

test('0027 falha fechado para C presente sem B exata', async (t) => {
    const db = await openTestDatabase(t);
    await db.exec(`CREATE TABLE clover_raid_reward_proposals (id INTEGER PRIMARY KEY, raid_id INTEGER)`);
    await createObjects(db, RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS);

    await assert.rejects(
        run0027(db),
        (error) => error?.code === 'raid_reward_proposal_idempotency_base_mapping_required'
    );
});

test('0027 falha fechado para C exata apoiada em B divergente sem reescrever C', async (t) => {
    const db = await openTestDatabase(t);
    await db.exec(`CREATE TABLE clover_raid_reward_proposals (id INTEGER PRIMARY KEY, raid_id INTEGER NOT NULL, proposed_by TEXT)`);
    await createObjects(db, RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS);
    const before = await db.all(`SELECT name, sql FROM sqlite_schema
        WHERE name LIKE 'clover_raid_reward_review_%' OR name LIKE 'idx_clover_raid_reward_review_%'
        ORDER BY name`);

    await assert.rejects(
        run0027(db),
        (error) => error?.code === 'raid_reward_proposal_idempotency_base_mapping_required'
    );
    assert.deepEqual(await db.all(`SELECT name, sql FROM sqlite_schema
        WHERE name LIKE 'clover_raid_reward_review_%' OR name LIKE 'idx_clover_raid_reward_review_%'
        ORDER BY name`), before);
});
