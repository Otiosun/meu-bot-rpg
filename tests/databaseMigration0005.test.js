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
    QUICK_EVALUATION_TARGETS,
} = require('../helpers/clover/schemaMigrationCatalog');

const MIGRATIONS_THROUGH_0004 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 4));

function tempDatabasePath(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0005-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'database.sqlite');
}

async function createPrerequisites(db, { quickTable = true, legacyBaseColumns = false, allQuickColumns = false } = {}) {
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
    `);
    if (quickTable) {
        const base = legacyBaseColumns
            ? ', quoted_message_key TEXT DEFAULT NULL, scene_sent_at TEXT DEFAULT NULL, scene_source TEXT DEFAULT NULL, evaluated_at TEXT DEFAULT NULL'
            : '';
        const salary = allQuickColumns
            ? ', salary_eligible INTEGER DEFAULT NULL, salary_service_type TEXT DEFAULT NULL'
            : '';
        await db.exec(`CREATE TABLE clover_quick_evaluations (id INTEGER PRIMARY KEY${base}${salary})`);
    }
}

test('0005 versiona exatamente seis colunas de avaliações rápidas e segunda execução é no-op', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db);

    const first = await runCloverSchemaMigrations(db, { migrations: CURRENT_SCHEMA_MIGRATIONS });
    assert.equal(first.latestVersion, 5);
    assert.equal(first.appliedCount, 5);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 5);
    for (const target of QUICK_EVALUATION_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, target.column);
    }
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => Number(row.version)), [1, 2, 3, 4, 5]);

    const second = await runCloverSchemaMigrations(db, { migrations: CURRENT_SCHEMA_MIGRATIONS });
    assert.equal(second.appliedCount, 0);
});

test('0005 completa apenas os dois campos salariais quando o schema-base já possui os quatro campos de cena', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db, { legacyBaseColumns: true });

    await runCloverSchemaMigrations(db, { migrations: CURRENT_SCHEMA_MIGRATIONS });
    assert.equal(await columnExists(db, 'clover_quick_evaluations', 'salary_eligible'), true);
    assert.equal(await columnExists(db, 'clover_quick_evaluations', 'salary_service_type'), true);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 5);
});

test('0005 falha fechado se clover_quick_evaluations não existe e preserva ledger em 0004', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db, { quickTable: false });
    await runCloverSchemaMigrations(db, { migrations: MIGRATIONS_THROUGH_0004 });

    await assert.rejects(
        runCloverSchemaMigrations(db, { migrations: CURRENT_SCHEMA_MIGRATIONS }),
        (error) => error?.code === 'migration_precondition_failed' && error?.table === 'clover_quick_evaluations'
    );
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 4);
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => Number(row.version)), [1, 2, 3, 4]);
});

test('checksum da 0005 cobre os seis targets externos', () => {
    const migration = CURRENT_SCHEMA_MIGRATIONS[4];
    const checksum = migrationChecksum(migration);
    assert.equal(checksum, '26e651f18483a8edffd3ff84062cdadb73f327963dc478aa69d421a2171fce49');
    const altered = {
        ...migration,
        checksumMaterial: migration.checksumMaterial.slice(0, 5),
    };
    assert.notEqual(migrationChecksum(altered), checksum);
});
