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
    ROLL_ATTEMPT_STATE_MIGRATION,
    ROLL_ATTEMPT_STATE_TARGETS,
} = require('../helpers/clover/schemaMigrationCatalog');

const MIGRATIONS_THROUGH_0014 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 14));
const MIGRATIONS_THROUGH_0015 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 15));
const EXPECTED_CHECKSUM = '3b43ca25e0c877db9aa37102c7cec08eefe84b7cfd3adbfcdf3f90e9d54a7519';

function tempDatabasePath(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0015-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'database.sqlite');
}

async function createPrerequisites(db, { includeState = false } = {}) {
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

    if (includeState) {
        for (const target of ROLL_ATTEMPT_STATE_TARGETS) {
            await db.exec(`ALTER TABLE jogadores ADD COLUMN ${target.column} ${target.definition}`);
        }
    }
}

async function applyThrough(db, migrations) {
    return applySchemaMigrations(db, { migrations });
}

test('0015 adiciona exatamente as 3 colunas de tentativas/sacrifício e segunda aplicação é no-op', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db);

    await applyThrough(db, MIGRATIONS_THROUGH_0014);
    const before = await db.all('PRAGMA table_info(jogadores)');
    const beforeNames = new Set(before.map((row) => row.name));

    await applyThrough(db, MIGRATIONS_THROUGH_0015);
    const after = await db.all('PRAGMA table_info(jogadores)');
    const added = after.map((row) => row.name).filter((name) => !beforeNames.has(name)).sort();
    assert.deepEqual(added, ROLL_ATTEMPT_STATE_TARGETS.map((target) => target.column).sort());

    const fingerprint = JSON.stringify(after);
    await applyThrough(db, MIGRATIONS_THROUGH_0015);
    assert.equal(JSON.stringify(await db.all('PRAGMA table_info(jogadores)')), fingerprint);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 15);
});

test('0015 é no-op em schema completo e preserva tentativas + sacrifício sem reset', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db, { includeState: true });

    const attempts = JSON.stringify([{ tipo: 'especial', usado: true }, { tipo: 'extra', usado: false }]);
    await db.run(`
        INSERT INTO jogadores (
            id, nome, tentativas_especiais, roll_sacrifice_used, roll_sacrifice_used_at
        ) VALUES (?, ?, ?, ?, ?)
    `, ['legacy-player', 'Legacy', attempts, 1, '2026-07-01 12:34:56']);

    const before = await db.get('SELECT * FROM jogadores WHERE id = ?', ['legacy-player']);
    const schemaBefore = JSON.stringify(await db.all('PRAGMA table_info(jogadores)'));

    await applyThrough(db, MIGRATIONS_THROUGH_0015);

    const after = await db.get('SELECT * FROM jogadores WHERE id = ?', ['legacy-player']);
    assert.deepEqual(after, before);
    assert.equal(JSON.stringify(await db.all('PRAGMA table_info(jogadores)')), schemaBefore);
    assert.equal(after.tentativas_especiais, attempts);
    assert.equal(after.roll_sacrifice_used, 1);
    assert.equal(after.roll_sacrifice_used_at, '2026-07-01 12:34:56');
});

test('0015 falha fechado sem jogadores e preserva ledger/user_version em 14', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db);
    await applyThrough(db, MIGRATIONS_THROUGH_0014);
    await db.exec('DROP TABLE jogadores');

    await assert.rejects(
        applyThrough(db, MIGRATIONS_THROUGH_0015),
        (error) => error?.code === 'migration_precondition_failed' && error?.table === 'jogadores'
    );

    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 14);
    const ledger = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(ledger.map((row) => Number(row.version)), [1,2,3,4,5,6,7,8,9,10,11,12,13,14]);
});

test('0015 possui 3 targets únicos, checksum fixo e zero UPDATE/reset', () => {
    assert.equal(ROLL_ATTEMPT_STATE_MIGRATION.version, 15);
    assert.equal(ROLL_ATTEMPT_STATE_MIGRATION.key, '0015_roll_attempt_state_columns');
    assert.equal(ROLL_ATTEMPT_STATE_TARGETS.length, 3);
    const keys = ROLL_ATTEMPT_STATE_TARGETS.map((target) => `${target.table}.${target.column}`);
    assert.equal(new Set(keys).size, 3);
    assert.equal(migrationChecksum(ROLL_ATTEMPT_STATE_MIGRATION), EXPECTED_CHECKSUM);
    assert.doesNotMatch(String(ROLL_ATTEMPT_STATE_MIGRATION.up), /\bUPDATE\b/i);

    const altered = {
        ...ROLL_ATTEMPT_STATE_MIGRATION,
        description: `${ROLL_ATTEMPT_STATE_MIGRATION.description} alterada`,
    };
    assert.notEqual(migrationChecksum(altered), EXPECTED_CHECKSUM);
});
