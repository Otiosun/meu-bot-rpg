'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openCloverDatabase, readPragmaScalar } = require('../helpers/clover/databaseConnection');
const {
    CORE_MIGRATIONS,
    MIGRATION_TABLE,
    columnExists,
    migrationChecksum,
    runCloverSchemaMigrations,
} = require('../helpers/clover/schemaMigrationService');
const {
    CURRENT_SCHEMA_MIGRATIONS,
    MARKET_REQUEST_TARGETS,
} = require('../helpers/clover/schemaMigrationCatalog');

const MIGRATIONS_THROUGH_0004 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 4));

function tempDatabasePath(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0004-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'database.sqlite');
}

async function createPrerequisiteTables(db, { marketRequestColumns = false, omitWeeklyRequests = false } = {}) {
    await db.exec(`
        CREATE TABLE clover_character_stats (id INTEGER PRIMARY KEY, ph_accumulated INTEGER DEFAULT 0, ph_available INTEGER DEFAULT 0);
        CREATE TABLE clover_box_openings (id INTEGER PRIMARY KEY, roll_basis_points INTEGER DEFAULT NULL);
        CREATE TABLE clover_inventory_reservations (id INTEGER PRIMARY KEY, expires_at TEXT DEFAULT NULL);
        CREATE TABLE clover_consumable_uses (id INTEGER PRIMARY KEY, effect_category TEXT DEFAULT NULL);
        CREATE TABLE player_onboarding (player_id TEXT PRIMARY KEY, step_payload TEXT DEFAULT '{}');
        CREATE TABLE pending_magic_confirmations (player_id TEXT PRIMARY KEY, magic_label TEXT NOT NULL, roll_number INTEGER DEFAULT NULL);
        CREATE TABLE group_settings (group_id TEXT PRIMARY KEY, enabled INTEGER DEFAULT 0, reception_enabled INTEGER DEFAULT 0, reception_type TEXT DEFAULT NULL);
        CREATE TABLE clover_market_listings (
            id INTEGER PRIMARY KEY,
            listing_key TEXT NOT NULL${marketRequestColumns ? ', idempotency_key TEXT DEFAULT NULL' : ''}
        );
    `);
    if (!omitWeeklyRequests) {
        await db.exec(`
            CREATE TABLE clover_weekly_npc_requests (
                id INTEGER PRIMARY KEY,
                request_key TEXT NOT NULL${marketRequestColumns ? ", required_quality TEXT NOT NULL DEFAULT 'qualquer', required_condition TEXT NOT NULL DEFAULT 'qualquer'" : ''}
            )
        `);
    }
}

test('0004 versiona exatamente três colunas de mercado/pedidos e segunda execução é no-op', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisiteTables(db);

    const first = await runCloverSchemaMigrations(db, { migrations: MIGRATIONS_THROUGH_0004 });
    assert.equal(first.latestVersion, 4);
    assert.equal(first.appliedCount, 4);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 4);
    for (const target of MARKET_REQUEST_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    const rows = await db.all(`SELECT version, migration_key FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => Number(row.version)), [1, 2, 3, 4]);

    const second = await runCloverSchemaMigrations(db, { migrations: MIGRATIONS_THROUGH_0004 });
    assert.equal(second.appliedCount, 0);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 4);
});

test('0004 é schema-no-op quando as três colunas já existem', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisiteTables(db, { marketRequestColumns: true });

    const result = await runCloverSchemaMigrations(db, { migrations: MIGRATIONS_THROUGH_0004 });
    assert.equal(result.appliedCount, 4);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 4);
});

test('0004 reverte idempotency_key se tabela de pedidos estiver ausente', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisiteTables(db, { omitWeeklyRequests: true });
    await runCloverSchemaMigrations(db, { migrations: CORE_MIGRATIONS.slice(0, 3) });

    await assert.rejects(
        runCloverSchemaMigrations(db, { migrations: MIGRATIONS_THROUGH_0004 }),
        (error) => error?.code === 'migration_precondition_failed' && error?.table === 'clover_weekly_npc_requests'
    );

    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 3);
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => Number(row.version)), [1, 2, 3]);
    assert.equal(await columnExists(db, 'clover_market_listings', 'idempotency_key'), false);
});

test('checksum da 0004 cobre os três targets externos', () => {
    const migration = MIGRATIONS_THROUGH_0004[3];
    const checksum = migrationChecksum(migration);
    assert.equal(checksum, '669721ef1c7d99d84215564691e262fe9b786ecd0cc85578dc174f0b5d5e363e');
    const altered = {
        ...migration,
        checksumMaterial: [...migration.checksumMaterial, { table: 'x', column: 'y', definition: 'TEXT' }],
    };
    assert.notEqual(migrationChecksum(altered), checksum);
});
