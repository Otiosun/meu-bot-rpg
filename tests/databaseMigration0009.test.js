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
    ADMIN_SERVICE_TARGETS,
    CURRENT_SCHEMA_MIGRATIONS,
} = require('../helpers/clover/schemaMigrationCatalog');

const MIGRATIONS_THROUGH_0008 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 8));

function tempDatabasePath(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0009-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'database.sqlite');
}

async function createPrerequisites(db, { adminTable = true, allAdminColumns = false } = {}) {
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
        CREATE TABLE clover_quick_evaluations (id INTEGER PRIMARY KEY, quoted_message_key TEXT DEFAULT NULL, scene_sent_at TEXT DEFAULT NULL, scene_source TEXT DEFAULT NULL, evaluated_at TEXT DEFAULT NULL, salary_eligible INTEGER DEFAULT NULL, salary_service_type TEXT DEFAULT NULL);
        CREATE TABLE player_rolls (player_id TEXT NOT NULL, roll_number INTEGER NOT NULL, kingdom TEXT DEFAULT '-', grimoire_rank TEXT DEFAULT '-', grimoire_symbol TEXT DEFAULT '-', magic_scope TEXT DEFAULT '-', roll_version TEXT DEFAULT 'legacy', kingdom_key TEXT DEFAULT NULL, social_class_key TEXT DEFAULT NULL, race_key TEXT DEFAULT NULL, grimoire_key TEXT DEFAULT NULL, magic_rarity_key TEXT DEFAULT NULL, roll_payload TEXT DEFAULT '{}', PRIMARY KEY (player_id, roll_number));
        CREATE TABLE clover_item_templates (template_key TEXT PRIMARY KEY, is_custom INTEGER NOT NULL DEFAULT 0, requestable INTEGER NOT NULL DEFAULT 0, marketable INTEGER NOT NULL DEFAULT 1, duplicable INTEGER NOT NULL DEFAULT 1, created_by TEXT DEFAULT 'system', updated_by TEXT DEFAULT NULL, archived_at TEXT DEFAULT NULL);
        CREATE TABLE clover_inventory_items (id INTEGER PRIMARY KEY, player_id TEXT NOT NULL, item_name TEXT NOT NULL, template_key TEXT DEFAULT NULL, catalog_version INTEGER DEFAULT 1, category TEXT DEFAULT 'material', origin TEXT DEFAULT 'Clover', status TEXT DEFAULT 'disponivel', quality TEXT DEFAULT 'comum', base_price INTEGER DEFAULT 0, reference_price INTEGER DEFAULT 0, durability_current INTEGER DEFAULT NULL, durability_max INTEGER DEFAULT NULL, bound INTEGER DEFAULT 0, transferable INTEGER DEFAULT 1, equipped_slot TEXT DEFAULT NULL, expires_at TEXT DEFAULT NULL, updated_at TEXT DEFAULT NULL, properties_json TEXT DEFAULT NULL, effects_json TEXT DEFAULT NULL);
    `);

    if (adminTable) {
        const columns = allAdminColumns
            ? ", target_player_id TEXT DEFAULT NULL, evaluation_id INTEGER DEFAULT NULL, paid_points INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', service_week_key TEXT DEFAULT NULL, scene_week_key TEXT DEFAULT NULL, scene_sent_at TEXT DEFAULT NULL, evaluated_at TEXT DEFAULT NULL, created_by TEXT DEFAULT NULL, voided_at TEXT DEFAULT NULL, voided_by TEXT DEFAULT NULL, reason TEXT DEFAULT NULL, metadata_json TEXT DEFAULT NULL"
            : '';
        await db.exec(`
            CREATE TABLE clover_admin_service_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                evaluator_id TEXT NOT NULL,
                modality_key TEXT NOT NULL,
                modality_label TEXT NOT NULL,
                weight INTEGER NOT NULL DEFAULT 0,
                points INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT 'quick_evaluation',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
                ${columns}
            )
        `);
    }
}

test('0009 versiona exatamente treze colunas de Admin Service e segunda execução é no-op', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db);

    const first = await runCloverSchemaMigrations(db, { migrations: CURRENT_SCHEMA_MIGRATIONS });
    assert.equal(first.latestVersion, 9);
    assert.equal(first.appliedCount, 9);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 9);
    for (const target of ADMIN_SERVICE_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, target.column);
    }
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => Number(row.version)), [1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const second = await runCloverSchemaMigrations(db, { migrations: CURRENT_SCHEMA_MIGRATIONS });
    assert.equal(second.appliedCount, 0);
});

test('0009 é schema-no-op quando Admin Service já possui as treze colunas', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db, { allAdminColumns: true });

    const result = await runCloverSchemaMigrations(db, { migrations: CURRENT_SCHEMA_MIGRATIONS });
    assert.equal(result.appliedCount, 9);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 9);
});

test('0009 falha fechado se clover_admin_service_entries não existe e preserva ledger em 0008', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db, { adminTable: false });
    await runCloverSchemaMigrations(db, { migrations: MIGRATIONS_THROUGH_0008 });

    await assert.rejects(
        runCloverSchemaMigrations(db, { migrations: CURRENT_SCHEMA_MIGRATIONS }),
        (error) => error?.code === 'migration_precondition_failed'
            && error?.table === 'clover_admin_service_entries'
    );
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 8);
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => Number(row.version)), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('checksum da 0009 cobre os treze targets e a migration não contém UPDATE', () => {
    const migration = CURRENT_SCHEMA_MIGRATIONS[8];
    const checksum = migrationChecksum(migration);
    assert.equal(checksum, 'd9b5ecc46dc044c3c560eb0d9e383ad38e3e11f19b32b51325a78b51f89a8b99');
    assert.doesNotMatch(String(migration.up), /UPDATE\s+/i);
    const altered = { ...migration, checksumMaterial: migration.checksumMaterial.slice(0, 12) };
    assert.notEqual(migrationChecksum(altered), checksum);
});
