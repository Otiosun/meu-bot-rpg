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
    PLAYER_PATENT_MIGRATION,
    PLAYER_PATENT_TARGETS,
} = require('../helpers/clover/schemaMigrationCatalog');

const MIGRATIONS_THROUGH_0017 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 17));
const MIGRATIONS_THROUGH_0018 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 18));
const EXPECTED_CHECKSUM = '94ac8996fac0d9be6ca0c4a0e09538ebd92a0aa4f6c2fe166976ee6885f562c2';

function tempDatabasePath(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0018-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'database.sqlite');
}

async function createPrerequisites(db, { includePatent = false } = {}) {
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

    if (includePatent) {
        for (const target of PLAYER_PATENT_TARGETS) {
            await db.exec(`ALTER TABLE jogadores ADD COLUMN ${target.column} ${target.definition}`);
        }
    }
}

async function applyThrough(db, migrations) {
    return applySchemaMigrations(db, { migrations });
}

test('0018 adiciona exatamente a coluna patente e segunda aplicação é no-op', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db);

    await applyThrough(db, MIGRATIONS_THROUGH_0017);
    const before = await db.all('PRAGMA table_info(jogadores)');
    const beforeNames = new Set(before.map((row) => row.name));

    await applyThrough(db, MIGRATIONS_THROUGH_0018);
    const after = await db.all('PRAGMA table_info(jogadores)');
    const added = after.map((row) => row.name).filter((name) => !beforeNames.has(name)).sort();
    assert.deepEqual(added, ['patente']);

    const patent = after.find((row) => row.name === 'patente');
    assert.equal(String(patent.type).toUpperCase(), 'TEXT');
    assert.equal(patent.dflt_value, "'-'");

    const fingerprint = JSON.stringify(after);
    await applyThrough(db, MIGRATIONS_THROUGH_0018);
    assert.equal(JSON.stringify(await db.all('PRAGMA table_info(jogadores)')), fingerprint);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 18);
});

test('0018 é schema-no-op e preserva patente existente sem promoção ou normalização', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db, { includePatent: true });

    await db.run(
        'INSERT INTO jogadores (id, nome, patente) VALUES (?, ?, ?)',
        ['captain-player', 'Capitão legado', 'Capitão']
    );
    await db.run(
        'INSERT INTO jogadores (id, nome, patente) VALUES (?, ?, ?)',
        ['base-player', 'Sem patente', '-']
    );

    const before = await db.all('SELECT id, nome, patente FROM jogadores ORDER BY id');
    const schemaBefore = JSON.stringify(await db.all('PRAGMA table_info(jogadores)'));

    await applyThrough(db, MIGRATIONS_THROUGH_0018);

    const after = await db.all('SELECT id, nome, patente FROM jogadores ORDER BY id');
    assert.deepEqual(after, before);
    assert.equal(JSON.stringify(await db.all('PRAGMA table_info(jogadores)')), schemaBefore);
    assert.deepEqual(after.map((row) => row.patente), ['-', 'Capitão']);
});

test('0018 falha fechado sem jogadores e preserva ledger/user_version em 17', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db);
    await applyThrough(db, MIGRATIONS_THROUGH_0017);
    await db.exec('DROP TABLE jogadores');

    await assert.rejects(
        applyThrough(db, MIGRATIONS_THROUGH_0018),
        (error) => error?.code === 'migration_precondition_failed' && error?.table === 'jogadores'
    );

    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 17);
    const ledger = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(ledger.map((row) => Number(row.version)), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17]);
});

test('0018 possui 1 target único, checksum fixo e zero UPDATE/backfill', () => {
    assert.equal(PLAYER_PATENT_MIGRATION.version, 18);
    assert.equal(PLAYER_PATENT_MIGRATION.key, '0018_player_patent_column');
    assert.equal(PLAYER_PATENT_TARGETS.length, 1);
    assert.deepEqual(PLAYER_PATENT_TARGETS[0], {
        table: 'jogadores',
        column: 'patente',
        definition: "TEXT DEFAULT '-'",
    });
    assert.equal(migrationChecksum(PLAYER_PATENT_MIGRATION), EXPECTED_CHECKSUM);
    assert.doesNotMatch(String(PLAYER_PATENT_MIGRATION.up), /\bUPDATE\b/i);

    const altered = {
        ...PLAYER_PATENT_MIGRATION,
        description: `${PLAYER_PATENT_MIGRATION.description} alterada`,
    };
    assert.notEqual(migrationChecksum(altered), EXPECTED_CHECKSUM);
});
