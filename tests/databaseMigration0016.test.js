'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openCloverDatabase, readPragmaScalar } = require('../helpers/clover/databaseConnection');
const {
    MIGRATION_TABLE,
    applySchemaMigrations,
    migrationChecksum,
} = require('../helpers/clover/schemaMigrationService');
const {
    CURRENT_SCHEMA_MIGRATIONS,
    STORY_STATE_MIGRATION,
    STORY_STATE_TARGETS,
} = require('../helpers/clover/schemaMigrationCatalog');

const MIGRATIONS_THROUGH_0015 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 15));
const MIGRATIONS_THROUGH_0016 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 16));
const EXPECTED_CHECKSUM = 'dde11c5e1b4a302ab8f30182bda61a979c6da4000e7f4976d95eec8db6d5ccfd';

function tempDatabasePath(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0016-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'database.sqlite');
}

async function createPrerequisites(db, { includeStory = false } = {}) {
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
    `);

    if (includeStory) {
        for (const target of STORY_STATE_TARGETS) {
            await db.exec(`ALTER TABLE jogadores ADD COLUMN ${target.column} ${target.definition}`);
        }
    }
}

async function applyThrough(db, migrations) {
    return applySchemaMigrations(db, { migrations });
}

test('0016 adiciona exatamente as 8 colunas de história e segunda aplicação é no-op', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db);

    await applyThrough(db, MIGRATIONS_THROUGH_0015);
    const before = await db.all('PRAGMA table_info(jogadores)');
    const beforeNames = new Set(before.map((row) => row.name));

    await applyThrough(db, MIGRATIONS_THROUGH_0016);
    const after = await db.all('PRAGMA table_info(jogadores)');
    const added = after.map((row) => row.name).filter((name) => !beforeNames.has(name)).sort();
    assert.deepEqual(added, STORY_STATE_TARGETS.map((target) => target.column).sort());

    const fingerprint = JSON.stringify(after);
    await applyThrough(db, MIGRATIONS_THROUGH_0016);
    assert.equal(JSON.stringify(await db.all('PRAGMA table_info(jogadores)')), fingerprint);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 16);
});

test('0016 é schema-no-op e preserva estado e conteúdo de história existente', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db, { includeStory: true });

    const extras = JSON.stringify([{ titulo: 'Passado', texto: 'Preservar exatamente.' }]);
    await db.run(`
        INSERT INTO jogadores (
            id, nome, historia_status, historia_status_updated_at,
            historia_aprovada_at, historia_aprovada_by, historia_pv_sent_at,
            historia_motivo, gancho_narrativo, historias_extras
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        'legacy-player', 'Legacy', 'aprovada', '2026-07-01 11:00:00',
        '2026-07-01 12:00:00', 'admin-fixture', '2026-07-01 12:05:00',
        null, 'Gancho legado', extras,
    ]);

    const before = await db.get('SELECT * FROM jogadores WHERE id = ?', ['legacy-player']);
    const schemaBefore = JSON.stringify(await db.all('PRAGMA table_info(jogadores)'));

    await applyThrough(db, MIGRATIONS_THROUGH_0016);

    const after = await db.get('SELECT * FROM jogadores WHERE id = ?', ['legacy-player']);
    assert.deepEqual(after, before);
    assert.equal(JSON.stringify(await db.all('PRAGMA table_info(jogadores)')), schemaBefore);
    assert.equal(after.historia_status, 'aprovada');
    assert.equal(after.historia_aprovada_by, 'admin-fixture');
    assert.equal(after.gancho_narrativo, 'Gancho legado');
    assert.equal(after.historias_extras, extras);
});

test('0016 falha fechado sem jogadores e preserva ledger/user_version em 15', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db);
    await applyThrough(db, MIGRATIONS_THROUGH_0015);
    await db.exec('DROP TABLE jogadores');

    await assert.rejects(
        applyThrough(db, MIGRATIONS_THROUGH_0016),
        (error) => error?.code === 'schema_table_missing' && error?.table === 'jogadores'
    );

    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 15);
    const ledger = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(ledger.map((row) => Number(row.version)), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]);
});

test('0016 possui 8 targets únicos, checksum fixo e zero UPDATE/backfill', () => {
    assert.equal(STORY_STATE_MIGRATION.version, 16);
    assert.equal(STORY_STATE_MIGRATION.key, '0016_story_state_columns');
    assert.equal(STORY_STATE_TARGETS.length, 8);
    const keys = STORY_STATE_TARGETS.map((target) => `${target.table}.${target.column}`);
    assert.equal(new Set(keys).size, 8);
    assert.equal(migrationChecksum(STORY_STATE_MIGRATION), EXPECTED_CHECKSUM);
    assert.doesNotMatch(String(STORY_STATE_MIGRATION.up), /\bUPDATE\b/i);

    const altered = {
        ...STORY_STATE_MIGRATION,
        description: `${STORY_STATE_MIGRATION.description} alterada`,
    };
    assert.notEqual(migrationChecksum(altered), EXPECTED_CHECKSUM);
});
