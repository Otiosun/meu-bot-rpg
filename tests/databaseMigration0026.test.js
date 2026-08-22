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
    RAID_IDEMPOTENCY_REQUESTS_INDEXES,
    RAID_IDEMPOTENCY_REQUESTS_KEY,
    RAID_IDEMPOTENCY_REQUESTS_MIGRATION,
    RAID_IDEMPOTENCY_REQUESTS_TABLES,
    RAID_IDEMPOTENCY_REQUESTS_VERSION,
    inspectRaidIdempotencyRequestsSchemaState,
} = require('../helpers/clover/schemaMigrationCatalog');

async function openTestDatabase(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0026-raid-idempotency-'));
    const filename = path.join(dir, 'database.sqlite');
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return db;
}

async function run0026(db) {
    return runCloverSchemaMigrations(db, {
        migrations: [RAID_IDEMPOTENCY_REQUESTS_MIGRATION],
    });
}

async function ledgerVersions(db) {
    if (!await tableExists(db, MIGRATION_TABLE)) return [];
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    return rows.map((row) => Number(row.version));
}

async function createExactFixture(db) {
    for (const table of RAID_IDEMPOTENCY_REQUESTS_TABLES) {
        await db.exec(table.sql);
    }
    for (const index of RAID_IDEMPOTENCY_REQUESTS_INDEXES) {
        await db.exec(index.sql);
    }
}

async function schemaRows(db) {
    return db.all(
        `SELECT type, name, tbl_name, sql
         FROM sqlite_schema
         WHERE name IN (${[...RAID_IDEMPOTENCY_REQUESTS_TABLES, ...RAID_IDEMPOTENCY_REQUESTS_INDEXES]
             .map(() => '?').join(',')})
         ORDER BY type, name`,
        [
            ...RAID_IDEMPOTENCY_REQUESTS_TABLES.map((entry) => entry.name),
            ...RAID_IDEMPOTENCY_REQUESTS_INDEXES.map((entry) => entry.name),
        ]
    );
}

test('0026 define duas tabelas e dois indices canonicos de idempotencia Raid', () => {
    assert.equal(RAID_IDEMPOTENCY_REQUESTS_VERSION, 26);
    assert.equal(RAID_IDEMPOTENCY_REQUESTS_KEY, '0026_raid_idempotency_requests');
    assert.deepEqual(
        RAID_IDEMPOTENCY_REQUESTS_TABLES.map((entry) => entry.name),
        ['clover_raid_creation_requests', 'clover_raid_mutation_requests']
    );
    assert.deepEqual(
        RAID_IDEMPOTENCY_REQUESTS_INDEXES.map((entry) => entry.name),
        ['idx_clover_raid_creation_status', 'idx_clover_raid_mutation_requests_status']
    );
});

test('0026 cria shape vazio sem sintetizar requests para historico de Raid', async (t) => {
    const db = await openTestDatabase(t);
    await db.exec(`
        CREATE TABLE clover_raids (id INTEGER PRIMARY KEY, raid_key TEXT NOT NULL, status TEXT NOT NULL);
        INSERT INTO clover_raids (id, raid_key, status) VALUES (7, 'HIST-0026', 'completed');
    `);

    const result = await run0026(db);
    assert.equal(result.latestVersion, 26);
    assert.equal(result.appliedCount, 1);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 26);
    assert.deepEqual(await ledgerVersions(db), [26]);

    const state = await inspectRaidIdempotencyRequestsSchemaState(db);
    assert.equal(state.kind, 'exact');
    assert.equal(state.indexValid, true);
    for (const table of RAID_IDEMPOTENCY_REQUESTS_TABLES) {
        assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ${table.name}`)).n, 0, table.name);
    }
    assert.equal((await db.get(`SELECT COUNT(*) AS n FROM clover_raids`)).n, 1);
    assert.equal(await tableExists(db, 'clover_raid_reward_deliveries'), false);
});

test('0026 e no-op em shape exato e preserva rows e schema', async (t) => {
    const db = await openTestDatabase(t);
    await createExactFixture(db);
    await db.run(
        `INSERT INTO clover_raid_creation_requests
         (idempotency_key, fingerprint, actor_id, status, processing_token, lease_expires_at,
          raid_id, result_json, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['creation-old', 'f-create', 'host', 'completed', 'token-c', '2026-08-01 10:00:00',
            9, '{"raid":9}', '2026-08-01 09:00:00', '2026-08-01 09:01:00', '2026-08-01 09:02:00']
    );
    await db.run(
        `INSERT INTO clover_raid_mutation_requests
         (idempotency_key, operation, fingerprint, actor_id, raid_id, subject_player_id, status,
          processing_token, lease_expires_at, result_json, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['mutation-old', 'join', 'f-mutation', 'host', 9, 'player', 'processing', 'token-m',
            '2026-08-01 10:00:00', '{"joined":true}', '2026-08-01 09:00:00', '2026-08-01 09:01:00', null]
    );
    const beforeCreation = await db.all('SELECT * FROM clover_raid_creation_requests');
    const beforeMutation = await db.all('SELECT * FROM clover_raid_mutation_requests');
    const beforeSchema = await schemaRows(db);

    await run0026(db);

    assert.deepEqual(await db.all('SELECT * FROM clover_raid_creation_requests'), beforeCreation);
    assert.deepEqual(await db.all('SELECT * FROM clover_raid_mutation_requests'), beforeMutation);
    assert.deepEqual(await schemaRows(db), beforeSchema);
    assert.equal((await inspectRaidIdempotencyRequestsSchemaState(db)).exact, true);
});

test('0026 aceita pending, processing e completed sem normalizar estado', async (t) => {
    const db = await openTestDatabase(t);
    await createExactFixture(db);
    for (const status of ['pending', 'processing', 'completed']) {
        await db.run(
            `INSERT INTO clover_raid_creation_requests (idempotency_key, fingerprint, actor_id, status)
             VALUES (?, 'f', 'actor', ?)`,
            [`creation-${status}`, status]
        );
        await db.run(
            `INSERT INTO clover_raid_mutation_requests
             (idempotency_key, operation, fingerprint, actor_id, raid_id, status)
             VALUES (?, 'join', 'f', 'actor', 1, ?)`,
            [`mutation-${status}`, status]
        );
    }

    await run0026(db);

    assert.deepEqual(
        (await db.all('SELECT status FROM clover_raid_creation_requests ORDER BY idempotency_key')).map((row) => row.status),
        ['completed', 'pending', 'processing']
    );
    assert.deepEqual(
        (await db.all('SELECT status FROM clover_raid_mutation_requests ORDER BY idempotency_key')).map((row) => row.status),
        ['completed', 'pending', 'processing']
    );
});

test('0026 falha fechado se somente creation existe', async (t) => {
    const db = await openTestDatabase(t);
    await db.exec(RAID_IDEMPOTENCY_REQUESTS_TABLES[0].sql);

    await assert.rejects(
        run0026(db),
        (error) => error?.code === 'raid_idempotency_requests_schema_mapping_required'
            && error?.reason === 'partial_tables'
    );
    assert.equal(await tableExists(db, 'clover_raid_creation_requests'), true);
    assert.equal(await tableExists(db, 'clover_raid_mutation_requests'), false);
    assert.deepEqual(await ledgerVersions(db), []);
});

test('0026 falha fechado se somente mutation existe', async (t) => {
    const db = await openTestDatabase(t);
    await db.exec(RAID_IDEMPOTENCY_REQUESTS_TABLES[1].sql);

    await assert.rejects(
        run0026(db),
        (error) => error?.code === 'raid_idempotency_requests_schema_mapping_required'
            && error?.reason === 'partial_tables'
    );
    assert.equal(await tableExists(db, 'clover_raid_creation_requests'), false);
    assert.equal(await tableExists(db, 'clover_raid_mutation_requests'), true);
    assert.deepEqual(await ledgerVersions(db), []);
});

test('0026 falha fechado para table-shape incompativel sem reparar', async (t) => {
    const db = await openTestDatabase(t);
    await createExactFixture(db);
    await db.exec('DROP TABLE clover_raid_creation_requests');
    await db.exec(
        RAID_IDEMPOTENCY_REQUESTS_TABLES[0].sql.replace(
            'actor_id TEXT NOT NULL',
            'actor_id TEXT DEFAULT NULL'
        )
    );

    await assert.rejects(
        run0026(db),
        (error) => error?.code === 'raid_idempotency_requests_schema_mapping_required'
            && error?.reason === 'table_shape'
    );
    const row = await db.get(
        `SELECT sql FROM sqlite_schema WHERE type='table' AND name='clover_raid_creation_requests'`
    );
    assert.match(row.sql, /actor_id TEXT DEFAULT NULL/);
    assert.deepEqual(await ledgerVersions(db), []);
});

test('0026 falha fechado para indice ausente ou com ordem divergente', async (t) => {
    const missing = await openTestDatabase(t);
    await createExactFixture(missing);
    await missing.exec('DROP INDEX idx_clover_raid_creation_status');
    await assert.rejects(
        run0026(missing),
        (error) => error?.code === 'raid_idempotency_requests_index_mapping_required'
            && error?.indexes?.some((entry) => entry.name === 'idx_clover_raid_creation_status')
    );
    assert.equal(
        await missing.get(`SELECT 1 AS found FROM sqlite_schema WHERE type='index' AND name='idx_clover_raid_creation_status'`),
        undefined
    );

    const wrong = await openTestDatabase(t);
    await createExactFixture(wrong);
    await wrong.exec('DROP INDEX idx_clover_raid_mutation_requests_status');
    await wrong.exec(
        `CREATE INDEX idx_clover_raid_mutation_requests_status
         ON clover_raid_mutation_requests (updated_at, status, lease_expires_at)`
    );
    await assert.rejects(
        run0026(wrong),
        (error) => error?.code === 'raid_idempotency_requests_index_mapping_required'
            && error?.indexes?.some((entry) => entry.name === 'idx_clover_raid_mutation_requests_status')
    );
    assert.equal(Number(await readPragmaScalar(wrong, 'user_version')), 0);
});

test('0026 falha fechado se nome de indice canonico esta ocupado em outra tabela', async (t) => {
    const db = await openTestDatabase(t);
    await db.exec(`
        CREATE TABLE external_request_shadow (id INTEGER PRIMARY KEY, status TEXT, lease_expires_at TEXT, updated_at TEXT);
        CREATE INDEX idx_clover_raid_creation_status
        ON external_request_shadow (status, lease_expires_at, updated_at);
    `);

    await assert.rejects(
        run0026(db),
        (error) => error?.code === 'raid_idempotency_requests_index_mapping_required'
            && error?.indexes?.some((entry) => entry.observedTable === 'external_request_shadow')
    );
    assert.equal(await tableExists(db, 'clover_raid_creation_requests'), false);
    assert.equal(await tableExists(db, 'clover_raid_mutation_requests'), false);
});

test('0026 preserva indice extra nao canonico em family exata', async (t) => {
    const db = await openTestDatabase(t);
    await createExactFixture(db);
    await db.exec(
        `CREATE INDEX extra_raid_creation_actor
         ON clover_raid_creation_requests (actor_id)`
    );

    await run0026(db);

    assert.ok(await db.get(
        `SELECT 1 AS found FROM sqlite_schema WHERE type='index' AND name='extra_raid_creation_actor'`
    ));
    assert.equal((await inspectRaidIdempotencyRequestsSchemaState(db)).exact, true);
});

test('0026 falha fechado para status armazenado invalido sem normalizar', async (t) => {
    const db = await openTestDatabase(t);
    await createExactFixture(db);
    await db.exec('PRAGMA ignore_check_constraints = ON');
    await db.run(
        `INSERT INTO clover_raid_mutation_requests
         (idempotency_key, operation, fingerprint, actor_id, raid_id, status)
         VALUES ('bad-status', 'join', 'f', 'actor', 1, 'replayed')`
    );
    await db.exec('PRAGMA ignore_check_constraints = OFF');

    await assert.rejects(
        run0026(db),
        (error) => error?.code === 'raid_idempotency_requests_state_mapping_required'
            && error?.table === 'clover_raid_mutation_requests'
            && error?.idempotencyKey === 'bad-status'
            && error?.status === 'replayed'
    );
    assert.equal(
        (await db.get(`SELECT status FROM clover_raid_mutation_requests WHERE idempotency_key='bad-status'`)).status,
        'replayed'
    );
    assert.deepEqual(await ledgerVersions(db), []);
});