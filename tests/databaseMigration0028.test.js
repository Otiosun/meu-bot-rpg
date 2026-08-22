'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openCloverDatabase, readPragmaScalar } = require('../helpers/clover/databaseConnection');
const { MIGRATION_TABLE, runCloverSchemaMigrations } = require('../helpers/clover/schemaMigrationService');
const {
    RAID_REWARD_PROPOSAL_HISTORY_MIGRATION,
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY,
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_MIGRATION,
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS,
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_VERSION,
    inspectRaidRewardProposalIdempotencySchemaState,
} = require('../helpers/clover/schemaMigrationCatalog');

function openFileDatabase(filename) {
    return openCloverDatabase({ filename });
}

function runThrough0028(db) {
    return runCloverSchemaMigrations(db, {
        migrations: [RAID_REWARD_PROPOSAL_HISTORY_MIGRATION, RAID_REWARD_PROPOSAL_IDEMPOTENCY_MIGRATION],
    });
}

test('0028 formaliza Family C de intents, events e strict context guard', () => {
    assert.equal(RAID_REWARD_PROPOSAL_IDEMPOTENCY_VERSION, 28);
    assert.equal(RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY, '0028_raid_reward_proposal_idempotency');
    assert.equal(RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS.filter((item) => item.type === 'table').length, 2);
    assert.equal(RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS.filter((item) => item.type === 'index').length, 2);
    assert.equal(RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS.filter((item) => item.type === 'trigger').length, 4);
});

test('interrupcao real apos 0027 persiste B exata e C ausente; reabertura aplica 0028 sem alterar B', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0027-interruption-'));
    const filename = path.join(dir, 'database.sqlite');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    let db = await openFileDatabase(filename);
    await runCloverSchemaMigrations(db, { migrations: [RAID_REWARD_PROPOSAL_HISTORY_MIGRATION] });
    const beforeClose = await inspectRaidRewardProposalIdempotencySchemaState(db);
    assert.equal(beforeClose.base.kind, 'exact');
    assert.equal(beforeClose.history.history.kind, 'exact');
    assert.equal(beforeClose.idempotency.kind, 'absent');
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 27);
    assert.equal((await db.get(`SELECT migration_key FROM ${MIGRATION_TABLE} ORDER BY version DESC LIMIT 1`)).migration_key, '0027_raid_reward_proposal_history');
    await db.close();

    db = await openFileDatabase(filename);
    await db.run(`INSERT INTO clover_raid_reward_proposals (raid_id, proposed_by, snapshot_hash) VALUES (7, 'author@lid', 'h1')`);
    const authorsBefore = await db.all('SELECT * FROM clover_raid_reward_proposal_authors');
    const revisionsBefore = await db.all('SELECT * FROM clover_raid_reward_proposal_revisions');
    const result = await runThrough0028(db);
    const after = await inspectRaidRewardProposalIdempotencySchemaState(db);
    assert.equal(result.latestVersion, 28);
    assert.equal(after.base.kind, 'exact');
    assert.equal(after.history.history.kind, 'exact');
    assert.equal(after.idempotency.kind, 'exact');
    assert.deepEqual(await db.all('SELECT * FROM clover_raid_reward_proposal_authors'), authorsBefore);
    assert.deepEqual(await db.all('SELECT * FROM clover_raid_reward_proposal_revisions'), revisionsBefore);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 28);
    await db.close();
});

test('0028 exige B exata e falha fechado para C parcial', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0028-fail-closed-'));
    const db = await openFileDatabase(path.join(dir, 'database.sqlite'));
    t.after(async () => { await db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    await runCloverSchemaMigrations(db, { migrations: [RAID_REWARD_PROPOSAL_HISTORY_MIGRATION] });
    await db.exec(RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS[0].sql);
    await assert.rejects(runThrough0028(db), (error) => error?.code === 'raid_reward_proposal_idempotency_schema_mapping_required');
});

test('DB atual B exata + C exata torna 0027/0028 no-op estrutural e preserva dados', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0028-current-noop-'));
    const db = await openFileDatabase(path.join(dir, 'database.sqlite'));
    t.after(async () => { await db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    await runThrough0028(db);
    await db.run(`INSERT INTO clover_raid_reward_proposals (raid_id, proposed_by, snapshot_hash) VALUES (7, 'author@lid', 'h1')`);
    await db.run(`INSERT INTO clover_raid_reward_review_intents
        (idempotency_key, proposal_id, raid_id, actor_id, decision, fingerprint, status)
        VALUES ('current-noop', 1, 7, 'reviewer@lid', 'approve', 'fp', 'completed')`);
    const schemaBefore = await db.all(`SELECT type, name, sql FROM sqlite_schema
        WHERE name LIKE 'clover_raid_reward_%' OR name LIKE 'idx_clover_raid_reward_%' OR name LIKE 'trg_clover_raid_reward_%' ORDER BY type, name`);
    const intentBefore = await db.get(`SELECT * FROM clover_raid_reward_review_intents WHERE idempotency_key = 'current-noop'`);

    await RAID_REWARD_PROPOSAL_HISTORY_MIGRATION.up(db);
    await RAID_REWARD_PROPOSAL_IDEMPOTENCY_MIGRATION.up(db);

    assert.deepEqual(await db.all(`SELECT type, name, sql FROM sqlite_schema
        WHERE name LIKE 'clover_raid_reward_%' OR name LIKE 'idx_clover_raid_reward_%' OR name LIKE 'trg_clover_raid_reward_%' ORDER BY type, name`), schemaBefore);
    assert.deepEqual(await db.get(`SELECT * FROM clover_raid_reward_review_intents WHERE idempotency_key = 'current-noop'`), intentBefore);
});
