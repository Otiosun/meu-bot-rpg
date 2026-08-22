'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openCloverDatabase, readPragmaScalar } = require('../helpers/clover/databaseConnection');
const {
    MIGRATION_TABLE,
    runCloverSchemaMigrations,
    tableExists,
} = require('../helpers/clover/schemaMigrationService');
const {
    RAID_SUPPORT_INDEXES,
    RAID_SUPPORT_TABLES,
    RAID_SUPPORT_TABLES_KEY,
    RAID_SUPPORT_TABLES_MIGRATION,
    RAID_SUPPORT_TABLES_VERSION,
    inspectRaidSupportSchemaState,
} = require('../helpers/clover/schemaMigrationCatalog');

async function openTestDatabase(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0025-raid-support-'));
    const filename = path.join(dir, 'database.sqlite');
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return db;
}

async function run0025(db) {
    return runCloverSchemaMigrations(db, {
        migrations: [RAID_SUPPORT_TABLES_MIGRATION],
    });
}

async function ledgerVersions(db) {
    const exists = await tableExists(db, MIGRATION_TABLE);
    if (!exists) return [];
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    return rows.map((row) => Number(row.version));
}

async function createExactSupportFixture(db) {
    for (const table of RAID_SUPPORT_TABLES) {
        await db.exec(table.sql);
    }
    for (const index of RAID_SUPPORT_INDEXES) {
        await db.exec(index.sql);
    }
}

test('0025 define seis tabelas auxiliares e seis indices canonicos de Raid', () => {
    assert.equal(RAID_SUPPORT_TABLES_VERSION, 25);
    assert.equal(RAID_SUPPORT_TABLES_KEY, '0025_raid_support_tables');
    assert.deepEqual(
        RAID_SUPPORT_TABLES.map((entry) => entry.name),
        [
            'clover_raid_hosts',
            'clover_raid_loadout_items',
            'clover_raid_item_events',
            'clover_raid_conditions',
            'clover_raid_reward_deliveries',
            'clover_raid_events',
        ]
    );
    assert.deepEqual(
        RAID_SUPPORT_INDEXES.map((entry) => entry.name),
        [
            'idx_clover_raid_hosts_active',
            'idx_clover_raid_loadout_participant',
            'idx_clover_raid_item_events_raid',
            'idx_clover_raid_conditions_raid',
            'idx_clover_raid_reward_deliveries_player',
            'idx_clover_raid_events_raid',
        ]
    );
});

test('0025 em schema auxiliar totalmente ausente cria shape canonico vazio sem backfill', async (t) => {
    const db = await openTestDatabase(t);
    await db.exec(`
        CREATE TABLE clover_raids (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            raid_key TEXT,
            status TEXT,
            created_at TEXT
        )
    `);
    await db.run(
        `INSERT INTO clover_raids (raid_key, status, created_at)
         VALUES ('HIST-SUPPORT-1', 'completed', '2026-06-10 12:00:00')`
    );

    const result = await run0025(db);
    assert.equal(result.latestVersion, 25);
    assert.equal(result.appliedCount, 1);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 25);
    assert.deepEqual(await ledgerVersions(db), [25]);

    const state = await inspectRaidSupportSchemaState(db);
    assert.equal(state.kind, 'exact');
    assert.equal(state.indexValid, true);
    assert.equal(state.exact, true);
    for (const table of RAID_SUPPORT_TABLES) {
        assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ${table.name}`)).n, 0, table.name);
    }
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_raids')).n, 1);
});

test('0025 reconhece shape canonico preexistente e faz no-op preservando dados e sequences', async (t) => {
    const db = await openTestDatabase(t);
    await createExactSupportFixture(db);

    await db.run(
        `INSERT INTO clover_raid_hosts
         (id, raid_id, player_id, role, status, assigned_by, created_at, metadata_json)
         VALUES (7, 5, 'host-7', 'owner', 'active', 'system', '2026-07-01 10:00:00', '{"historic":true}')`
    );
    await db.run(
        `INSERT INTO clover_raid_loadout_items
         (id, raid_id, participant_id, player_id, inventory_item_id, reservation_id, slot_key,
          quantity, quantity_consumed, durability_start, durability_current, snapshot_json,
          created_at, updated_at, metadata_json)
         VALUES (8, 5, 9, 'player-8', 11, 12, 'main_hand', 1, 0, 50, 45,
                 '{"weapon":"old"}', '2026-07-01 10:00:00', '2026-07-01 11:00:00', '{"historic":true}')`
    );
    await db.run(
        `INSERT INTO clover_raid_item_events
         (id, raid_id, participant_id, loadout_item_id, event_type, amount, cause,
          created_by, created_at, idempotency_key, metadata_json)
         VALUES (9, 5, 9, 8, 'durability_loss', 5, 'impact', 'host-7',
                 '2026-07-01 11:30:00', 'evt-9', '{"historic":true}')`
    );
    await db.run(
        `INSERT INTO clover_raid_conditions
         (id, raid_id, target_type, participant_id, target_player_id, condition_key, label,
          severity, status, applied_by, applied_at, metadata_json)
         VALUES (10, 5, 'player', 9, 'player-8', 'burn', 'Queimadura',
                 'normal', 'active', 'host-7', '2026-07-01 12:00:00', '{"historic":true}')`
    );
    await db.run(
        `INSERT INTO clover_raid_reward_deliveries
         (id, raid_id, reward_id, player_id, status, result_json, created_at, metadata_json)
         VALUES (11, 5, 13, 'player-8', 'completed', '{"yulls":100}',
                 '2026-07-01 13:00:00', '{"historic":true}')`
    );
    await db.run(
        `INSERT INTO clover_raid_events
         (id, raid_id, action, actor_id, subject_player_id, before_json, after_json,
          created_at, idempotency_key, metadata_json)
         VALUES (12, 5, 'historic_action', 'host-7', 'player-8', '{}', '{}',
                 '2026-07-01 14:00:00', 'raid-event-12', '{"historic":true}')`
    );
    await db.run(`UPDATE sqlite_sequence SET seq = 40 WHERE name = 'clover_raid_hosts'`);
    await db.run(`UPDATE sqlite_sequence SET seq = 60 WHERE name = 'clover_raid_events'`);

    const beforeRows = {};
    for (const table of RAID_SUPPORT_TABLES) {
        beforeRows[table.name] = await db.all(`SELECT * FROM ${table.name} ORDER BY id`);
    }
    const beforeSchema = await db.all(
        `SELECT type, name, tbl_name, sql
         FROM sqlite_schema
         WHERE name IN (${[...RAID_SUPPORT_TABLES, ...RAID_SUPPORT_INDEXES].map(() => '?').join(',')})
         ORDER BY type, name`,
        [...RAID_SUPPORT_TABLES.map((entry) => entry.name), ...RAID_SUPPORT_INDEXES.map((entry) => entry.name)]
    );

    await run0025(db);

    for (const table of RAID_SUPPORT_TABLES) {
        assert.deepEqual(await db.all(`SELECT * FROM ${table.name} ORDER BY id`), beforeRows[table.name], table.name);
    }
    assert.deepEqual(
        await db.all(
            `SELECT type, name, tbl_name, sql
             FROM sqlite_schema
             WHERE name IN (${[...RAID_SUPPORT_TABLES, ...RAID_SUPPORT_INDEXES].map(() => '?').join(',')})
             ORDER BY type, name`,
            [...RAID_SUPPORT_TABLES.map((entry) => entry.name), ...RAID_SUPPORT_INDEXES.map((entry) => entry.name)]
        ),
        beforeSchema
    );
    assert.equal(Number((await db.get(`SELECT seq FROM sqlite_sequence WHERE name='clover_raid_hosts'`)).seq), 40);
    assert.equal(Number((await db.get(`SELECT seq FROM sqlite_sequence WHERE name='clover_raid_events'`)).seq), 60);
    const state = await inspectRaidSupportSchemaState(db);
    assert.equal(state.exact, true);
});

test('0025 aceita indice extra nao canonico sem remove-lo', async (t) => {
    const db = await openTestDatabase(t);
    await createExactSupportFixture(db);
    await db.exec(`CREATE INDEX custom_raid_event_actor ON clover_raid_events (actor_id)`);

    await run0025(db);

    assert.ok(await db.get(
        `SELECT 1 AS found FROM sqlite_schema WHERE type='index' AND name='custom_raid_event_actor'`
    ));
    assert.equal((await inspectRaidSupportSchemaState(db)).exact, true);
});

test('0025 falha fechado se apenas parte das seis tabelas auxiliares existe', async (t) => {
    const db = await openTestDatabase(t);
    await db.exec(RAID_SUPPORT_TABLES[0].sql);

    await assert.rejects(
        run0025(db),
        (error) => error?.code === 'raid_support_schema_mapping_required'
            && error?.reason === 'partial_tables'
    );

    assert.equal(await tableExists(db, RAID_SUPPORT_TABLES[0].name), true);
    assert.equal(await tableExists(db, RAID_SUPPORT_TABLES[1].name), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
    assert.deepEqual(await ledgerVersions(db), []);
});

test('0025 falha fechado para table-shape auxiliar incompatível sem reparar silenciosamente', async (t) => {
    const db = await openTestDatabase(t);
    await createExactSupportFixture(db);
    await db.exec(`DROP TABLE clover_raid_conditions`);
    await db.exec(
        RAID_SUPPORT_TABLES.find((entry) => entry.name === 'clover_raid_conditions').sql.replace(
            "severity IN ('leve', 'normal', 'seria', 'critica')",
            "severity IN ('leve', 'normal', 'fatal')"
        )
    );

    await assert.rejects(
        run0025(db),
        (error) => error?.code === 'raid_support_schema_mapping_required'
            && error?.reason === 'table_shape'
    );

    const tableSql = (await db.get(
        `SELECT sql FROM sqlite_schema WHERE type='table' AND name='clover_raid_conditions'`
    )).sql;
    assert.match(tableSql, /'fatal'/);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
});

test('0025 nao recria indice canonico ausente em schema preexistente exato', async (t) => {
    const db = await openTestDatabase(t);
    await createExactSupportFixture(db);
    await db.exec(`DROP INDEX idx_clover_raid_events_raid`);

    await assert.rejects(
        run0025(db),
        (error) => error?.code === 'raid_support_index_mapping_required'
            && error?.indexes?.some((entry) => entry.name === 'idx_clover_raid_events_raid')
    );

    assert.equal(
        await db.get(`SELECT 1 AS found FROM sqlite_schema WHERE type='index' AND name='idx_clover_raid_events_raid'`),
        undefined
    );
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
});

test('0025 bloqueia nome de indice canonico ocupado por outro objeto quando tabelas estao ausentes', async (t) => {
    const db = await openTestDatabase(t);
    await db.exec(`
        CREATE TABLE external_raid_shadow (id INTEGER PRIMARY KEY, raid_id INTEGER, player_id TEXT);
        CREATE UNIQUE INDEX idx_clover_raid_hosts_active
        ON external_raid_shadow (raid_id, player_id)
        WHERE player_id IS NOT NULL;
    `);

    await assert.rejects(
        run0025(db),
        (error) => error?.code === 'raid_support_index_mapping_required'
    );

    assert.equal(await tableExists(db, 'clover_raid_hosts'), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
});

test('0025 detecta estado armazenado invalido em shape exato e nao o normaliza', async (t) => {
    const db = await openTestDatabase(t);
    await createExactSupportFixture(db);
    await db.exec('PRAGMA ignore_check_constraints = ON');
    await db.run(
        `INSERT INTO clover_raid_hosts
         (raid_id, player_id, role, status, assigned_by)
         VALUES (1, 'bad-host', 'spectator', 'active', 'system')`
    );
    await db.exec('PRAGMA ignore_check_constraints = OFF');

    await assert.rejects(
        run0025(db),
        (error) => error?.code === 'raid_support_state_mapping_required'
            && error?.table === 'clover_raid_hosts'
            && error?.rowId === 1
    );

    assert.equal(
        (await db.get(`SELECT role FROM clover_raid_hosts WHERE player_id='bad-host'`)).role,
        'spectator'
    );
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
    assert.deepEqual(await ledgerVersions(db), []);
});
