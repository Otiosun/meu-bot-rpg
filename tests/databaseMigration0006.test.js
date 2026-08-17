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
    migrationChecksum,
    runCloverSchemaMigrations,
} = require('../helpers/clover/schemaMigrationService');
const {
    CURRENT_SCHEMA_MIGRATIONS,
    PLAYER_ROLLS_TARGETS,
} = require('../helpers/clover/schemaMigrationCatalog');

const MIGRATIONS_THROUGH_0005 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 5));
const MIGRATIONS_THROUGH_0006 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 6));

function tempDatabasePath(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0006-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'database.sqlite');
}

async function createPrerequisites(db, { rollsTable = true, legacyBaseColumns = false, allRollColumns = false } = {}) {
    await db.exec(`
        CREATE TABLE clover_character_stats (id INTEGER PRIMARY KEY, ph_accumulated INTEGER DEFAULT 0, ph_available INTEGER DEFAULT 0);
        CREATE TABLE clover_box_openings (id INTEGER PRIMARY KEY, roll_basis_points INTEGER DEFAULT NULL);
        CREATE TABLE clover_inventory_reservations (id INTEGER PRIMARY KEY, expires_at TEXT DEFAULT NULL);
        CREATE TABLE clover_consumable_uses (id INTEGER PRIMARY KEY, effect_category TEXT DEFAULT NULL);
        CREATE TABLE player_onboarding (player_id TEXT PRIMARY KEY, step_payload TEXT DEFAULT '{}');
        CREATE TABLE pending_magic_confirmations (player_id TEXT PRIMARY KEY, magic_label TEXT NOT NULL, roll_number INTEGER DEFAULT NULL);
        CREATE TABLE group_settings (group_id TEXT PRIMARY KEY, enabled INTEGER DEFAULT 0, reception_enabled INTEGER DEFAULT 0, reception_type TEXT DEFAULT NULL);
        CREATE TABLE clover_market_listings (id INTEGER PRIMARY KEY, idempotency_key TEXT DEFAULT NULL);
        CREATE TABLE clover_weekly_npc_requests (id INTEGER PRIMARY KEY, required_quality TEXT NOT NULL DEFAULT 'qualquer', required_condition TEXT NOT NULL DEFAULT 'qualquer');
        CREATE TABLE clover_quick_evaluations (
            id INTEGER PRIMARY KEY,
            quoted_message_key TEXT DEFAULT NULL,
            scene_sent_at TEXT DEFAULT NULL,
            scene_source TEXT DEFAULT NULL,
            evaluated_at TEXT DEFAULT NULL,
            salary_eligible INTEGER DEFAULT NULL,
            salary_service_type TEXT DEFAULT NULL
        );
    `);
    if (rollsTable) {
        const base = legacyBaseColumns
            ? ", kingdom TEXT DEFAULT '-', grimoire_rank TEXT DEFAULT '-', grimoire_symbol TEXT DEFAULT '-', magic_scope TEXT DEFAULT '-'"
            : '';
        const modern = allRollColumns
            ? ", roll_version TEXT DEFAULT 'legacy', kingdom_key TEXT DEFAULT NULL, social_class_key TEXT DEFAULT NULL, race_key TEXT DEFAULT NULL, grimoire_key TEXT DEFAULT NULL, magic_rarity_key TEXT DEFAULT NULL, roll_payload TEXT DEFAULT '{}'"
            : '';
        await db.exec(`CREATE TABLE player_rolls (player_id TEXT NOT NULL, roll_number INTEGER NOT NULL${base}${modern}, PRIMARY KEY (player_id, roll_number))`);
    }
}

test('0006 versiona exatamente onze colunas de player_rolls e segunda execução é no-op', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db);

    const first = await runCloverSchemaMigrations(db, { migrations: MIGRATIONS_THROUGH_0006 });
    assert.equal(first.latestVersion, 6);
    assert.equal(first.appliedCount, 6);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 6);
    for (const target of PLAYER_ROLLS_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, target.column);
    }
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => Number(row.version)), [1, 2, 3, 4, 5, 6]);

    const second = await runCloverSchemaMigrations(db, { migrations: MIGRATIONS_THROUGH_0006 });
    assert.equal(second.appliedCount, 0);
});

test('0006 adiciona só as sete colunas modernas quando o schema-base já contém as quatro legadas', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db, { legacyBaseColumns: true });

    await runCloverSchemaMigrations(db, { migrations: MIGRATIONS_THROUGH_0006 });
    const modern = ['roll_version', 'kingdom_key', 'social_class_key', 'race_key', 'grimoire_key', 'magic_rarity_key', 'roll_payload'];
    for (const column of modern) {
        assert.equal(await columnExists(db, 'player_rolls', column), true, column);
    }
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 6);
});

test('0006 é schema-no-op quando player_rolls já possui as onze colunas', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db, { legacyBaseColumns: true, allRollColumns: true });

    const result = await runCloverSchemaMigrations(db, { migrations: MIGRATIONS_THROUGH_0006 });
    assert.equal(result.appliedCount, 6);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 6);
});

test('0006 falha fechado se player_rolls não existe e preserva ledger em 0005', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db, { rollsTable: false });
    await runCloverSchemaMigrations(db, { migrations: MIGRATIONS_THROUGH_0005 });

    await assert.rejects(
        runCloverSchemaMigrations(db, { migrations: MIGRATIONS_THROUGH_0006 }),
        (error) => error?.code === 'migration_precondition_failed' && error?.table === 'player_rolls'
    );
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 5);
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => Number(row.version)), [1, 2, 3, 4, 5]);
});

test('checksum da 0006 cobre os onze targets externos', () => {
    const migration = MIGRATIONS_THROUGH_0006[5];
    const checksum = migrationChecksum(migration);
    assert.equal(checksum, '072bfc35b3c777a240c8433b974e1c9ed172281570448f102721a159292b6a19');
    const altered = {
        ...migration,
        checksumMaterial: migration.checksumMaterial.slice(0, 10),
    };
    assert.notEqual(migrationChecksum(altered), checksum);
});
