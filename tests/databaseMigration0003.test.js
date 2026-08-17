'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openCloverDatabase, readPragmaScalar } = require('../helpers/clover/databaseConnection');
const {
    BOOTSTRAP_METADATA_TARGETS,
    CORE_MIGRATIONS,
    MIGRATION_TABLE,
    columnExists,
    migrationChecksum,
    runCloverSchemaMigrations,
} = require('../helpers/clover/schemaMigrationService');

function tempDatabasePath(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0003-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'database.sqlite');
}

async function createPrerequisiteTables(db, { metadataColumns = false, omitGroupSettings = false } = {}) {
    await db.exec(`
        CREATE TABLE clover_character_stats (id INTEGER PRIMARY KEY, ph_accumulated INTEGER DEFAULT 0, ph_available INTEGER DEFAULT 0);
        CREATE TABLE clover_box_openings (id INTEGER PRIMARY KEY, roll_basis_points INTEGER DEFAULT NULL);
        CREATE TABLE clover_inventory_reservations (id INTEGER PRIMARY KEY, expires_at TEXT DEFAULT NULL);
        CREATE TABLE clover_consumable_uses (id INTEGER PRIMARY KEY, effect_category TEXT DEFAULT NULL);
        CREATE TABLE player_onboarding (
            player_id TEXT PRIMARY KEY,
            current_step TEXT DEFAULT 'inicio'${metadataColumns ? ", step_payload TEXT DEFAULT '{}'" : ''}
        );
        CREATE TABLE pending_magic_confirmations (
            player_id TEXT PRIMARY KEY,
            magic_label TEXT NOT NULL${metadataColumns ? ', roll_number INTEGER DEFAULT NULL' : ''}
        );
    `);
    if (!omitGroupSettings) {
        await db.exec(`
            CREATE TABLE group_settings (
                group_id TEXT PRIMARY KEY,
                enabled INTEGER DEFAULT 0${metadataColumns ? ', reception_enabled INTEGER DEFAULT 0, reception_type TEXT DEFAULT NULL' : ''}
            )
        `);
    }
}

test('0003 versiona exatamente quatro colunas de bootstrap e segunda execução é no-op', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisiteTables(db);

    const first = await runCloverSchemaMigrations(db);
    assert.equal(first.latestVersion, 3);
    assert.equal(first.appliedCount, 3);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 3);
    for (const target of BOOTSTRAP_METADATA_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
    const second = await runCloverSchemaMigrations(db);
    assert.equal(second.appliedCount, 0);
});

test('0003 é schema-no-op quando as quatro colunas já existem', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisiteTables(db, { metadataColumns: true });

    const result = await runCloverSchemaMigrations(db);
    assert.equal(result.appliedCount, 3);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 3);
});

test('0003 faz rollback de colunas anteriores se group_settings estiver ausente', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisiteTables(db, { omitGroupSettings: true });
    await runCloverSchemaMigrations(db, { migrations: CORE_MIGRATIONS.slice(0, 2) });

    await assert.rejects(
        runCloverSchemaMigrations(db),
        (error) => error?.code === 'migration_precondition_failed' && error?.table === 'group_settings'
    );

    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 2);
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => Number(row.version)), [1, 2]);
    assert.equal(await columnExists(db, 'player_onboarding', 'step_payload'), false);
    assert.equal(await columnExists(db, 'pending_magic_confirmations', 'roll_number'), false);
});

test('checksum da 0003 cobre os targets externos', () => {
    const migration = CORE_MIGRATIONS[2];
    assert.equal(migrationChecksum(migration), 'ac9da088be053e0d24297410fda45848283e852389813a820de9073ebd452518');
    const altered = {
        ...migration,
        checksumMaterial: [...migration.checksumMaterial, { table: 'x', column: 'y', definition: 'TEXT' }],
    };
    assert.notEqual(migrationChecksum(altered), migrationChecksum(migration));
});
