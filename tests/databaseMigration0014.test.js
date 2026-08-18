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
    columnExists,
    migrationChecksum,
} = require('../helpers/clover/schemaMigrationService');
const {
    CHARACTER_TRAITS_MIGRATION,
    CHARACTER_TRAITS_TARGETS,
    CURRENT_SCHEMA_MIGRATIONS,
} = require('../helpers/clover/schemaMigrationCatalog');

const MIGRATIONS_THROUGH_0013 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 13));
const MIGRATIONS_THROUGH_0014 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 14));
const EXPECTED_CHECKSUM = '38cf9af135b931ff7a61e889e6c8b29d59ddaeb8da3ec62e8338af7007d3aaaa';

function tempDatabasePath(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0014-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'database.sqlite');
}

async function createPrerequisites(db, { includeTraits = false } = {}) {
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

    if (includeTraits) {
        for (const target of CHARACTER_TRAITS_TARGETS) {
            await db.exec(`ALTER TABLE jogadores ADD COLUMN ${target.column} ${target.definition}`);
        }
    }
}

async function applyThrough(db, migrations) {
    return applySchemaMigrations(db, { migrations });
}

test('0014 adiciona exatamente as 10 colunas de traços e segunda aplicação é no-op', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db);

    await applyThrough(db, MIGRATIONS_THROUGH_0013);
    const before = await db.all('PRAGMA table_info(jogadores)');
    const beforeNames = new Set(before.map((row) => row.name));

    await applyThrough(db, MIGRATIONS_THROUGH_0014);
    const after = await db.all('PRAGMA table_info(jogadores)');
    const afterNames = new Set(after.map((row) => row.name));
    const added = [...afterNames].filter((name) => !beforeNames.has(name)).sort();
    assert.deepEqual(added, CHARACTER_TRAITS_TARGETS.map((target) => target.column).sort());

    const fingerprint = JSON.stringify(after);
    await applyThrough(db, MIGRATIONS_THROUGH_0014);
    assert.equal(JSON.stringify(await db.all('PRAGMA table_info(jogadores)')), fingerprint);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 14);
});

test('0014 é no-op em schema completo e preserva conteúdo/key legado sem backfill', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db, { includeTraits: true });
    await db.run(`
        INSERT INTO jogadores (
            id, nome,
            aptidao_comum, aptidao_comum_key,
            marca_comum, marca_comum_key,
            aptidao_rara, aptidao_rara_key,
            marca_rara, marca_rara_key,
            anomalia, anomalia_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        'legacy-player', 'Legacy',
        'Aptidão Teste', 'aptidao_teste',
        'Marca Teste', 'marca_teste',
        '-', null,
        '-', null,
        'Anomalia legada sem key', null,
    ]);

    const before = await db.get('SELECT * FROM jogadores WHERE id = ?', ['legacy-player']);
    const schemaBefore = JSON.stringify(await db.all('PRAGMA table_info(jogadores)'));

    await applyThrough(db, MIGRATIONS_THROUGH_0014);

    const after = await db.get('SELECT * FROM jogadores WHERE id = ?', ['legacy-player']);
    assert.deepEqual(after, before);
    assert.equal(JSON.stringify(await db.all('PRAGMA table_info(jogadores)')), schemaBefore);
    assert.equal(after.anomalia, 'Anomalia legada sem key');
    assert.equal(after.anomalia_key, null);
});

test('0014 falha fechado sem jogadores e preserva ledger/user_version em 13', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db);
    await applyThrough(db, MIGRATIONS_THROUGH_0013);
    await db.exec('DROP TABLE jogadores');

    await assert.rejects(
        applyThrough(db, MIGRATIONS_THROUGH_0014),
        (error) => error?.code === 'schema_table_missing' && error?.table === 'jogadores'
    );

    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 13);
    const ledger = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(ledger.map((row) => Number(row.version)), [1,2,3,4,5,6,7,8,9,10,11,12,13]);
});

test('0014 possui 10 targets únicos, checksum fixo e zero UPDATE/backfill', () => {
    assert.equal(CHARACTER_TRAITS_MIGRATION.version, 14);
    assert.equal(CHARACTER_TRAITS_MIGRATION.key, '0014_character_trait_columns');
    assert.equal(CHARACTER_TRAITS_TARGETS.length, 10);
    const keys = CHARACTER_TRAITS_TARGETS.map((target) => `${target.table}.${target.column}`);
    assert.equal(new Set(keys).size, 10);
    assert.equal(migrationChecksum(CHARACTER_TRAITS_MIGRATION), EXPECTED_CHECKSUM);
    assert.doesNotMatch(String(CHARACTER_TRAITS_MIGRATION.up), /\bUPDATE\b/i);

    const altered = {
        ...CHARACTER_TRAITS_MIGRATION,
        description: `${CHARACTER_TRAITS_MIGRATION.description} alterada`,
    };
    assert.notEqual(migrationChecksum(altered), EXPECTED_CHECKSUM);
});
