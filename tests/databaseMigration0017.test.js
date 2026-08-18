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
    GAME_STATE_MIGRATION,
    GAME_STATE_TARGETS,
} = require('../helpers/clover/schemaMigrationCatalog');

const MIGRATIONS_THROUGH_0016 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 16));
const MIGRATIONS_THROUGH_0017 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 17));
const EXPECTED_CHECKSUM = '54951481617d6fe259a66402eb29218a89d3b35685cd1cbc91e65c4cf8c96734';

function tempDatabasePath(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0017-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'database.sqlite');
}

async function createPrerequisites(db, { includeGame = false } = {}) {
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

    if (includeGame) {
        for (const target of GAME_STATE_TARGETS) {
            await db.exec(`ALTER TABLE jogadores ADD COLUMN ${target.column} ${target.definition}`);
        }
    }
}

async function applyThrough(db, migrations) {
    return applySchemaMigrations(db, { migrations });
}

test('0017 adiciona exatamente as 4 colunas de estado de jogo e segunda aplicação é no-op', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db);

    await applyThrough(db, MIGRATIONS_THROUGH_0016);
    const before = await db.all('PRAGMA table_info(jogadores)');
    const beforeNames = new Set(before.map((row) => row.name));

    await applyThrough(db, MIGRATIONS_THROUGH_0017);
    const after = await db.all('PRAGMA table_info(jogadores)');
    const added = after.map((row) => row.name).filter((name) => !beforeNames.has(name)).sort();
    assert.deepEqual(added, GAME_STATE_TARGETS.map((target) => target.column).sort());

    const fingerprint = JSON.stringify(after);
    await applyThrough(db, MIGRATIONS_THROUGH_0017);
    assert.equal(JSON.stringify(await db.all('PRAGMA table_info(jogadores)')), fingerprint);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 17);
});

test('0017 é schema-no-op e preserva metadata histórica de acesso sem reconciliar estado', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db, { includeGame: true });

    await db.run(`
        INSERT INTO jogadores (
            id, nome, jogo_status, jogo_liberado_at, jogo_liberado_by, jogo_bloqueio_motivo
        ) VALUES (?, ?, ?, ?, ?, ?)
    `, [
        'legacy-player', 'Legacy', 'arquivado', '2026-06-01 12:00:00', 'admin-antigo', 'motivo histórico',
    ]);

    const before = await db.get('SELECT * FROM jogadores WHERE id = ?', ['legacy-player']);
    const schemaBefore = JSON.stringify(await db.all('PRAGMA table_info(jogadores)'));

    await applyThrough(db, MIGRATIONS_THROUGH_0017);

    const after = await db.get('SELECT * FROM jogadores WHERE id = ?', ['legacy-player']);
    assert.deepEqual(after, before);
    assert.equal(JSON.stringify(await db.all('PRAGMA table_info(jogadores)')), schemaBefore);
    assert.equal(after.jogo_status, 'arquivado');
    assert.equal(after.jogo_liberado_at, '2026-06-01 12:00:00');
    assert.equal(after.jogo_liberado_by, 'admin-antigo');
    assert.equal(after.jogo_bloqueio_motivo, 'motivo histórico');
});

test('0017 falha fechado sem jogadores e preserva ledger/user_version em 16', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db);
    await applyThrough(db, MIGRATIONS_THROUGH_0016);
    await db.exec('DROP TABLE jogadores');

    await assert.rejects(
        applyThrough(db, MIGRATIONS_THROUGH_0017),
        (error) => error?.code === 'schema_table_missing' && error?.table === 'jogadores'
    );

    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 16);
    const ledger = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(ledger.map((row) => Number(row.version)), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]);
});

test('0017 possui 4 targets únicos, checksum fixo e zero UPDATE/reconciliação', () => {
    assert.equal(GAME_STATE_MIGRATION.version, 17);
    assert.equal(GAME_STATE_MIGRATION.key, '0017_game_state_columns');
    assert.equal(GAME_STATE_TARGETS.length, 4);
    const keys = GAME_STATE_TARGETS.map((target) => `${target.table}.${target.column}`);
    assert.equal(new Set(keys).size, 4);
    assert.equal(migrationChecksum(GAME_STATE_MIGRATION), EXPECTED_CHECKSUM);
    assert.doesNotMatch(String(GAME_STATE_MIGRATION.up), /\bUPDATE\b/i);

    const altered = {
        ...GAME_STATE_MIGRATION,
        description: `${GAME_STATE_MIGRATION.description} alterada`,
    };
    assert.notEqual(migrationChecksum(altered), EXPECTED_CHECKSUM);
});
