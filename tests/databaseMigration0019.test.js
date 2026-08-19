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
    migrationChecksum,
} = require('../helpers/clover/schemaMigrationService');
const {
    CURRENT_SCHEMA_MIGRATIONS,
    SQUAD_COLUMNS_MIGRATION,
    SQUAD_COLUMNS_TARGETS,
} = require('../helpers/clover/schemaMigrationCatalog');

const MIGRATIONS_THROUGH_0018 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 18));
const MIGRATIONS_THROUGH_0019 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 19));
const EXPECTED_CHECKSUM = '7353f8ca72960f12c56bcf6619ee62e3dad497edd1d355c57a16e5e48982426c';

async function openTestDatabase(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0019-'));
    const filename = path.join(dir, 'database.sqlite');
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return db;
}

async function createPrerequisites(db, { includeSquadColumns = false } = {}) {
    await db.exec(`
        CREATE TABLE clover_character_stats (id INTEGER PRIMARY KEY);
        CREATE TABLE clover_box_openings (id INTEGER PRIMARY KEY);
        CREATE TABLE clover_inventory_reservations (id INTEGER PRIMARY KEY);
        CREATE TABLE clover_consumable_uses (id INTEGER PRIMARY KEY);
        CREATE TABLE player_onboarding (player_id TEXT PRIMARY KEY);
        CREATE TABLE pending_magic_confirmations (player_id TEXT PRIMARY KEY, magic_label TEXT NOT NULL);
        CREATE TABLE group_settings (group_id TEXT PRIMARY KEY);
        CREATE TABLE clover_market_listings (id INTEGER PRIMARY KEY);
        CREATE TABLE clover_weekly_npc_requests (id INTEGER PRIMARY KEY);
        CREATE TABLE clover_quick_evaluations (id INTEGER PRIMARY KEY);
        CREATE TABLE player_rolls (player_id TEXT NOT NULL, roll_number INTEGER NOT NULL, PRIMARY KEY (player_id, roll_number));
        CREATE TABLE clover_item_templates (template_key TEXT PRIMARY KEY);
        CREATE TABLE clover_inventory_items (id INTEGER PRIMARY KEY, player_id TEXT NOT NULL, item_name TEXT NOT NULL);
        CREATE TABLE clover_admin_service_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            evaluator_id TEXT NOT NULL,
            modality_key TEXT NOT NULL,
            modality_label TEXT NOT NULL
        );
        CREATE TABLE jogadores (id TEXT PRIMARY KEY, nome TEXT);
        CREATE TABLE clover_squads (
            squad_key TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            historical_stars INTEGER DEFAULT 0,
            current_stars INTEGER DEFAULT 0,
            black_stars INTEGER DEFAULT 0,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);

    if (includeSquadColumns) {
        for (const target of SQUAD_COLUMNS_TARGETS) {
            await db.exec(`ALTER TABLE clover_squads ADD COLUMN ${target.column} ${target.definition}`);
        }
    }
}

async function applyThrough(db, migrations) {
    return runCloverSchemaMigrations(db, { migrations });
}

test('0019 adiciona exatamente as 8 colunas legadas de Squads e segunda aplicação é no-op', async (t) => {
    const db = await openTestDatabase(t);
    await createPrerequisites(db);

    await applyThrough(db, MIGRATIONS_THROUGH_0018);
    const before = await db.all('PRAGMA table_info(clover_squads)');
    const beforeNames = new Set(before.map((row) => row.name));

    await applyThrough(db, MIGRATIONS_THROUGH_0019);
    const after = await db.all('PRAGMA table_info(clover_squads)');
    const added = after.map((row) => row.name).filter((name) => !beforeNames.has(name)).sort();
    assert.deepEqual(added, SQUAD_COLUMNS_TARGETS.map((target) => target.column).sort());

    for (const target of SQUAD_COLUMNS_TARGETS) {
        const column = after.find((row) => row.name === target.column);
        assert.ok(column, target.column);
        assert.equal(String(column.type).toUpperCase(), 'TEXT', target.column);
        assert.equal(column.dflt_value, 'NULL', target.column);
    }

    const fingerprint = JSON.stringify(after);
    await applyThrough(db, MIGRATIONS_THROUGH_0019);
    assert.equal(JSON.stringify(await db.all('PRAGMA table_info(clover_squads)')), fingerprint);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 19);
});

test('0019 é schema-no-op e preserva vínculos, comando e estado de sincronização existentes', async (t) => {
    const db = await openTestDatabase(t);
    await createPrerequisites(db, { includeSquadColumns: true });

    await db.run(
        `INSERT INTO clover_squads (
            squad_key, name, group_id, phrase, captain_name, captain_player_id,
            vice_captain_player_id, description_synced_at, description_sync_status,
            description_sync_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            'black-bulls',
            'Touros Negros',
            '120363000000000000@g.us',
            'Sem desistir.',
            'Yami',
            'captain-player',
            'vice-player',
            '2026-08-01 12:00:00',
            'ok',
            null,
        ]
    );

    const before = await db.get(
        `SELECT squad_key, name, group_id, phrase, captain_name, captain_player_id,
                vice_captain_player_id, description_synced_at, description_sync_status,
                description_sync_error
         FROM clover_squads
         WHERE squad_key = ?`,
        ['black-bulls']
    );
    const schemaBefore = JSON.stringify(await db.all('PRAGMA table_info(clover_squads)'));

    await applyThrough(db, MIGRATIONS_THROUGH_0019);

    const after = await db.get(
        `SELECT squad_key, name, group_id, phrase, captain_name, captain_player_id,
                vice_captain_player_id, description_synced_at, description_sync_status,
                description_sync_error
         FROM clover_squads
         WHERE squad_key = ?`,
        ['black-bulls']
    );
    assert.deepEqual(after, before);
    assert.equal(JSON.stringify(await db.all('PRAGMA table_info(clover_squads)')), schemaBefore);
});

test('0019 falha fechado sem clover_squads e preserva ledger/user_version em 18', async (t) => {
    const db = await openTestDatabase(t);
    await createPrerequisites(db);
    await applyThrough(db, MIGRATIONS_THROUGH_0018);
    await db.exec('DROP TABLE clover_squads');

    await assert.rejects(
        applyThrough(db, MIGRATIONS_THROUGH_0019),
        (error) => error?.code === 'migration_precondition_failed' && error?.table === 'clover_squads'
    );

    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 18);
    const ledger = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(ledger.map((row) => Number(row.version)), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18]);
});

test('0019 possui 8 targets únicos, checksum fixo e zero UPDATE/backfill', () => {
    assert.equal(SQUAD_COLUMNS_MIGRATION.version, 19);
    assert.equal(SQUAD_COLUMNS_MIGRATION.key, '0019_squad_columns');
    assert.equal(SQUAD_COLUMNS_TARGETS.length, 8);
    assert.equal(new Set(SQUAD_COLUMNS_TARGETS.map((target) => target.column)).size, 8);
    assert.deepEqual(
        SQUAD_COLUMNS_TARGETS.map((target) => target.column),
        [
            'group_id',
            'phrase',
            'captain_name',
            'captain_player_id',
            'vice_captain_player_id',
            'description_synced_at',
            'description_sync_status',
            'description_sync_error',
        ]
    );
    assert.equal(migrationChecksum(SQUAD_COLUMNS_MIGRATION), EXPECTED_CHECKSUM);
    assert.doesNotMatch(String(SQUAD_COLUMNS_MIGRATION.up), /\bUPDATE\b/i);

    const altered = {
        ...SQUAD_COLUMNS_MIGRATION,
        description: `${SQUAD_COLUMNS_MIGRATION.description} alterada`,
    };
    assert.notEqual(migrationChecksum(altered), EXPECTED_CHECKSUM);
});
