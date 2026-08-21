'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openCloverDatabase, readPragmaScalar } = require('../helpers/clover/databaseConnection');
const {
    MIGRATION_TABLE,
    columnExists,
    tableExists,
    runCloverSchemaMigrations,
} = require('../helpers/clover/schemaMigrationService');
const {
    RAID_REWARDS_V1_TABLE_SQL,
    RAID_REWARDS_V2_INDEX,
    RAID_REWARDS_V2_KEY,
    RAID_REWARDS_V2_MIGRATION,
    RAID_REWARDS_V2_REWARD_TYPES,
    RAID_REWARDS_V2_TABLE_SQL,
    RAID_REWARDS_V2_VERSION,
    inspectRaidRewardsSchemaState,
} = require('../helpers/clover/schemaMigrationCatalog');

async function openTestDatabase(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0023-raid-rewards-'));
    const filename = path.join(dir, 'database.sqlite');
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return db;
}

async function createV1(db, options = {}) {
    await db.exec(RAID_REWARDS_V1_TABLE_SQL);
    const indexColumns = options.indexColumns || RAID_REWARDS_V2_INDEX.columns;
    if (options.withIndex !== false) {
        await db.exec(
            `CREATE INDEX idx_clover_raid_rewards_raid
             ON clover_raid_rewards (${indexColumns.join(', ')})`
        );
    }
}

async function createV2(db) {
    await db.exec(RAID_REWARDS_V2_TABLE_SQL);
    await db.exec(`
        CREATE INDEX idx_clover_raid_rewards_raid
        ON clover_raid_rewards (raid_id, status, id)
    `);
}

async function run0023(db) {
    return runCloverSchemaMigrations(db, {
        migrations: [RAID_REWARDS_V2_MIGRATION],
    });
}

async function ledgerVersions(db) {
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    return rows.map((row) => Number(row.version));
}

test('0023 define table-shape V2 exato, tipos ampliados e indice canonico', () => {
    assert.equal(RAID_REWARDS_V2_VERSION, 23);
    assert.equal(RAID_REWARDS_V2_KEY, '0023_raid_rewards_v2');
    assert.deepEqual(RAID_REWARDS_V2_REWARD_TYPES, [
        'yulls', 'ph', 'stars', 'catalog_item', 'pa', 'pm', 'box',
    ]);
    assert.deepEqual(RAID_REWARDS_V2_INDEX, {
        name: 'idx_clover_raid_rewards_raid',
        table: 'clover_raid_rewards',
        columns: ['raid_id', 'status', 'id'],
    });
    assert.match(RAID_REWARDS_V1_TABLE_SQL, /reward_type IN \('yulls', 'ph', 'stars', 'catalog_item'\)/);
    assert.doesNotMatch(RAID_REWARDS_V1_TABLE_SQL, /\bresource_key\b/);
    assert.match(RAID_REWARDS_V2_TABLE_SQL, /'pa', 'pm', 'box'/);
    assert.match(RAID_REWARDS_V2_TABLE_SQL, /\bresource_key TEXT DEFAULT NULL\b/);
    assert.match(RAID_REWARDS_V2_TABLE_SQL, /reward_type = 'pm' AND amount != 0/);
});

test('0023 converte V1 exato preservando IDs, deliveries, dados, sequence e sem reaplicar reward', async (t) => {
    const db = await openTestDatabase(t);
    await createV1(db);
    await db.exec(`
        CREATE TABLE clover_raid_reward_deliveries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            raid_id INTEGER NOT NULL,
            reward_id INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'reversed')),
            result_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL,
            UNIQUE (reward_id, player_id)
        );
        CREATE INDEX idx_clover_raid_reward_deliveries_player
        ON clover_raid_reward_deliveries (player_id, created_at DESC, id DESC);
    `);
    await db.run(
        `INSERT INTO clover_raid_rewards
         (id, raid_id, target_type, target_player_id, reward_type, amount, template_key,
          label, reason, status, created_by, created_at, cancelled_at, cancelled_by, metadata_json)
         VALUES (7, 4, 'general', NULL, 'ph', 1, NULL,
                 '1 PH fora do teto semanal', 'snapshot', 'applied', 'host',
                 '2026-08-01 12:00:00', NULL, NULL, '{"unrestrictedByGameRule":true}')`
    );
    await db.run(
        `INSERT INTO clover_raid_reward_deliveries
         (id, raid_id, reward_id, player_id, status, result_json, created_at, metadata_json)
         VALUES (3, 4, 7, 'player-1', 'completed', '{"ph":1}', '2026-08-01 12:01:00', NULL)`
    );
    await db.run(
        `UPDATE sqlite_sequence SET seq = 50 WHERE name = 'clover_raid_rewards'`
    );

    const beforeReward = await db.get('SELECT * FROM clover_raid_rewards WHERE id = 7');
    const beforeDelivery = await db.get('SELECT * FROM clover_raid_reward_deliveries WHERE id = 3');

    const result = await run0023(db);
    assert.equal(result.latestVersion, 23);
    assert.equal(result.appliedCount, 1);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 23);
    assert.deepEqual(await ledgerVersions(db), [23]);

    const state = await inspectRaidRewardsSchemaState(db);
    assert.equal(state.kind, 'v2');
    assert.equal(state.indexValid, true);
    assert.deepEqual(state.unexpectedIndexes, []);
    assert.deepEqual(state.triggers, []);
    assert.deepEqual(state.dependentSchemaObjects, []);
    assert.deepEqual(state.inboundForeignKeys, []);

    const afterReward = await db.get('SELECT * FROM clover_raid_rewards WHERE id = 7');
    assert.deepEqual(afterReward, {
        id: beforeReward.id,
        raid_id: beforeReward.raid_id,
        target_type: beforeReward.target_type,
        target_player_id: beforeReward.target_player_id,
        reward_type: beforeReward.reward_type,
        amount: beforeReward.amount,
        template_key: beforeReward.template_key,
        resource_key: null,
        label: beforeReward.label,
        reason: beforeReward.reason,
        status: beforeReward.status,
        created_by: beforeReward.created_by,
        created_at: beforeReward.created_at,
        cancelled_at: beforeReward.cancelled_at,
        cancelled_by: beforeReward.cancelled_by,
        metadata_json: beforeReward.metadata_json,
    });
    assert.deepEqual(
        await db.get('SELECT * FROM clover_raid_reward_deliveries WHERE id = 3'),
        beforeDelivery
    );
    const sequence = await db.get(
        `SELECT seq FROM sqlite_sequence WHERE name = 'clover_raid_rewards'`
    );
    assert.equal(Number(sequence.seq), 50);

    const inserted = await db.run(
        `INSERT INTO clover_raid_rewards
         (raid_id, target_type, reward_type, amount, resource_key, label, status, created_by)
         VALUES (4, 'general', 'pm', -2, 'mana_pool', 'Ajuste PM', 'draft', 'host')`
    );
    assert.equal(Number(inserted.lastID), 51);
    assert.equal(await tableExists(db, 'clover_raid_monthly_reservations'), false);
    assert.equal(await tableExists(db, 'clover_raid_monthly_ledger'), false);
});

test('0023 e no-op real para V2 exato e preserva row, SQL e sequence', async (t) => {
    const db = await openTestDatabase(t);
    await createV2(db);
    await db.run(
        `INSERT INTO clover_raid_rewards
         (id, raid_id, target_type, target_player_id, reward_type, amount,
          template_key, resource_key, label, reason, status, created_by, created_at, metadata_json)
         VALUES (9, 5, 'player', 'p9', 'pa', 3, NULL, 'pa', 'PA', NULL,
                 'draft', 'host', '2026-08-02 10:00:00', '{"v2":true}')`
    );
    await db.run(
        `UPDATE sqlite_sequence SET seq = 40 WHERE name = 'clover_raid_rewards'`
    );
    const beforeSql = (await db.get(
        `SELECT sql FROM sqlite_schema WHERE type='table' AND name='clover_raid_rewards'`
    )).sql;
    const beforeRow = await db.get('SELECT * FROM clover_raid_rewards WHERE id = 9');

    await run0023(db);

    const afterSql = (await db.get(
        `SELECT sql FROM sqlite_schema WHERE type='table' AND name='clover_raid_rewards'`
    )).sql;
    assert.equal(afterSql, beforeSql);
    assert.deepEqual(await db.get('SELECT * FROM clover_raid_rewards WHERE id = 9'), beforeRow);
    const sequence = await db.get(
        `SELECT seq FROM sqlite_sequence WHERE name = 'clover_raid_rewards'`
    );
    assert.equal(Number(sequence.seq), 40);
    assert.equal((await inspectRaidRewardsSchemaState(db)).kind, 'v2');
});

test('0023 falha fechado para shape parcial V1+resource_key sem rebuild', async (t) => {
    const db = await openTestDatabase(t);
    await createV1(db);
    await db.exec(`ALTER TABLE clover_raid_rewards ADD COLUMN resource_key TEXT DEFAULT NULL`);
    await db.run(
        `INSERT INTO clover_raid_rewards
         (raid_id, target_type, reward_type, amount, label, status, created_by)
         VALUES (1, 'general', 'ph', 1, 'Legado parcial', 'draft', 'host')`
    );

    await assert.rejects(
        run0023(db),
        (error) => error?.code === 'raid_rewards_v2_schema_mapping_required'
            && error?.reason === 'table_shape'
    );

    assert.equal(await columnExists(db, 'clover_raid_rewards', 'resource_key'), true);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_raid_rewards')).n, 1);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
    assert.deepEqual(await ledgerVersions(db), []);
});

test('0023 falha fechado para indice canonico homonimo com colunas erradas', async (t) => {
    const db = await openTestDatabase(t);
    await createV1(db, { indexColumns: ['raid_id', 'id'] });

    await assert.rejects(
        run0023(db),
        (error) => error?.code === 'raid_rewards_v2_index_mapping_required'
            && error?.index === 'idx_clover_raid_rewards_raid'
    );

    const state = await inspectRaidRewardsSchemaState(db);
    assert.equal(state.kind, 'v1');
    assert.deepEqual(state.indexColumns, ['raid_id', 'id']);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
});

test('0023 bloqueia trigger/indice extra antes de rebuild para nao perder dependencia silenciosamente', async (t) => {
    const db = await openTestDatabase(t);
    await createV1(db);
    await db.exec(`
        CREATE TRIGGER clover_raid_rewards_shadow
        AFTER INSERT ON clover_raid_rewards
        BEGIN
            SELECT 1;
        END;
    `);

    await assert.rejects(
        run0023(db),
        (error) => error?.code === 'raid_rewards_v2_dependency_mapping_required'
            && error?.dependencies?.some((item) => item.kind === 'trigger'
                && item.name === 'clover_raid_rewards_shadow')
    );

    assert.ok(await db.get(
        `SELECT 1 AS found FROM sqlite_schema
         WHERE type='trigger' AND name='clover_raid_rewards_shadow'`
    ));
    assert.equal((await inspectRaidRewardsSchemaState(db)).kind, 'v1');
});

test('0023 bloqueia FK de entrada antes do rename/drop da tabela de rewards', async (t) => {
    const db = await openTestDatabase(t);
    await createV1(db);
    await db.exec(`
        CREATE TABLE external_reward_ref (
            id INTEGER PRIMARY KEY,
            reward_id INTEGER NOT NULL,
            FOREIGN KEY (reward_id) REFERENCES clover_raid_rewards(id)
        )
    `);

    await assert.rejects(
        run0023(db),
        (error) => error?.code === 'raid_rewards_v2_dependency_mapping_required'
            && error?.dependencies?.some((item) => item.kind === 'inbound_foreign_key')
    );

    assert.equal(await tableExists(db, 'external_reward_ref'), true);
    assert.equal((await inspectRaidRewardsSchemaState(db)).kind, 'v1');
});

test('0023 detecta estado V1 invalido e reverte sem renomear tabela', async (t) => {
    const db = await openTestDatabase(t);
    await createV1(db);
    await db.exec('PRAGMA ignore_check_constraints = ON');
    await db.run(
        `INSERT INTO clover_raid_rewards
         (raid_id, target_type, reward_type, amount, label, status, created_by)
         VALUES (2, 'general', 'pm', 1, 'Invalido V1', 'draft', 'host')`
    );
    await db.exec('PRAGMA ignore_check_constraints = OFF');

    await assert.rejects(
        run0023(db),
        (error) => error?.code === 'raid_rewards_v2_state_mapping_required'
            && error?.rewardId === 1
    );

    assert.equal((await inspectRaidRewardsSchemaState(db)).kind, 'v1');
    assert.equal(await tableExists(db, 'clover_raid_rewards_legacy_v1'), false);
    assert.equal((await db.get('SELECT reward_type FROM clover_raid_rewards WHERE id=1')).reward_type, 'pm');
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
    assert.deepEqual(await ledgerVersions(db), []);
});
