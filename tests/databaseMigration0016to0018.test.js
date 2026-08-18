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
    GAME_RELEASE_MIGRATION,
    GAME_RELEASE_TARGETS,
    HISTORY_WORKFLOW_MIGRATION,
    HISTORY_WORKFLOW_TARGETS,
    PLAYER_RANK_MIGRATION,
    PLAYER_RANK_TARGETS,
} = require('../helpers/clover/schemaMigrationCatalog');

const MIGRATIONS_THROUGH_0015 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 15));
const MIGRATIONS_THROUGH_0016 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 16));
const MIGRATIONS_THROUGH_0017 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 17));
const MIGRATIONS_THROUGH_0018 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 18));

const EXPECTED_CHECKSUMS = Object.freeze({
    16: 'f74e01eac6d576a7e551a1ff09a601ccb1701483b0718c90635366d871845fc4',
    17: 'acdad5b4d4e808cddc16ebcb2778f62632ae0ca6ca46a646b2c3c0693cf8699b',
    18: 'fcbe8f75561e7c40b1d372c3604d42e8350417f2f78b062464b7a32d6b5ffd7a',
});

function tempDatabasePath(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0016-0018-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'database.sqlite');
}

async function createPrerequisites(db) {
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
}

async function applyThrough(db, migrations) {
    return applySchemaMigrations(db, { migrations });
}

function columnNames(rows) {
    return new Set(rows.map((row) => row.name));
}

function addedColumns(before, after) {
    const beforeNames = columnNames(before);
    return after.map((row) => row.name).filter((name) => !beforeNames.has(name)).sort();
}

test('0016, 0017 e 0018 adicionam exatamente 8 + 4 + 1 colunas e reaplicação é no-op', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db);
    await applyThrough(db, MIGRATIONS_THROUGH_0015);

    const before16 = await db.all('PRAGMA table_info(jogadores)');
    await applyThrough(db, MIGRATIONS_THROUGH_0016);
    const after16 = await db.all('PRAGMA table_info(jogadores)');
    assert.deepEqual(addedColumns(before16, after16), HISTORY_WORKFLOW_TARGETS.map((target) => target.column).sort());

    await applyThrough(db, MIGRATIONS_THROUGH_0017);
    const after17 = await db.all('PRAGMA table_info(jogadores)');
    assert.deepEqual(addedColumns(after16, after17), GAME_RELEASE_TARGETS.map((target) => target.column).sort());

    await applyThrough(db, MIGRATIONS_THROUGH_0018);
    const after18 = await db.all('PRAGMA table_info(jogadores)');
    assert.deepEqual(addedColumns(after17, after18), PLAYER_RANK_TARGETS.map((target) => target.column).sort());

    const fingerprint = JSON.stringify(after18);
    await applyThrough(db, MIGRATIONS_THROUGH_0018);
    assert.equal(JSON.stringify(await db.all('PRAGMA table_info(jogadores)')), fingerprint);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 18);
});

test('0016→0018 preservam estados legados de história/jogo/patente sem reconciliação', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db);
    await applyThrough(db, MIGRATIONS_THROUGH_0015);

    for (const target of [...HISTORY_WORKFLOW_TARGETS, ...GAME_RELEASE_TARGETS, ...PLAYER_RANK_TARGETS]) {
        await db.exec(`ALTER TABLE jogadores ADD COLUMN ${target.column} ${target.definition}`);
    }

    await db.run(`
        INSERT INTO jogadores (
            id, nome,
            historia_status, historia_status_updated_at, historia_aprovada_at, historia_aprovada_by,
            historia_pv_sent_at, historia_motivo, gancho_narrativo, historias_extras,
            jogo_status, jogo_liberado_at, jogo_liberado_by, jogo_bloqueio_motivo, patente
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        'legacy-liberado-incompleto', 'Legacy A',
        'aprovada', '2026-06-01 10:00:00', '2026-06-01 10:00:00', 'migration',
        null, null, 'Gancho legado', '["extra"]',
        'liberado', null, null, null, 'Capitão',
    ]);

    await db.run(`
        INSERT INTO jogadores (
            id, nome,
            historia_status, historia_status_updated_at, historia_aprovada_at, historia_aprovada_by,
            historia_pv_sent_at, historia_motivo, gancho_narrativo, historias_extras,
            jogo_status, jogo_liberado_at, jogo_liberado_by, jogo_bloqueio_motivo, patente
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        'legacy-bloqueado-com-timestamp', 'Legacy B',
        'pendente', null, null, null,
        '2026-06-02 11:00:00', 'aguardando revisão', '-', '[]',
        'bloqueado', '2026-05-30 08:00:00', 'bot', 'estado legado', '-',
    ]);

    const before = await db.all('SELECT * FROM jogadores ORDER BY id');
    const schemaBefore = JSON.stringify(await db.all('PRAGMA table_info(jogadores)'));

    await applyThrough(db, MIGRATIONS_THROUGH_0018);

    const after = await db.all('SELECT * FROM jogadores ORDER BY id');
    assert.deepEqual(after, before);
    assert.equal(JSON.stringify(await db.all('PRAGMA table_info(jogadores)')), schemaBefore);
    assert.equal(after[0].jogo_status, 'bloqueado');
    assert.equal(after[0].jogo_liberado_at, '2026-05-30 08:00:00');
    assert.equal(after[1].jogo_status, 'liberado');
    assert.equal(after[1].jogo_liberado_at, null);
    assert.equal(after[1].patente, 'Capitão');
});

test('0016 falha fechado sem jogadores e preserva ledger/user_version em 15', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createPrerequisites(db);
    await applyThrough(db, MIGRATIONS_THROUGH_0015);
    await db.exec('DROP TABLE jogadores');

    await assert.rejects(
        applyThrough(db, MIGRATIONS_THROUGH_0018),
        (error) => error?.code === 'migration_precondition_failed' && error?.table === 'jogadores'
    );

    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 15);
    const ledger = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(ledger.map((row) => Number(row.version)), [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]);
});

test('0016→0018 têm targets únicos, checksums fixos e zero UPDATE/backfill', () => {
    const migrations = [HISTORY_WORKFLOW_MIGRATION, GAME_RELEASE_MIGRATION, PLAYER_RANK_MIGRATION];
    const targets = [...HISTORY_WORKFLOW_TARGETS, ...GAME_RELEASE_TARGETS, ...PLAYER_RANK_TARGETS];
    assert.deepEqual(migrations.map((migration) => migration.version), [16, 17, 18]);
    assert.deepEqual(migrations.map((migration) => migration.key), [
        '0016_history_workflow_columns',
        '0017_game_release_columns',
        '0018_player_rank_column',
    ]);
    assert.equal(HISTORY_WORKFLOW_TARGETS.length, 8);
    assert.equal(GAME_RELEASE_TARGETS.length, 4);
    assert.equal(PLAYER_RANK_TARGETS.length, 1);
    const keys = targets.map((target) => `${target.table}.${target.column}`);
    assert.equal(new Set(keys).size, 13);

    for (const migration of migrations) {
        assert.equal(migrationChecksum(migration), EXPECTED_CHECKSUMS[migration.version]);
        assert.doesNotMatch(String(migration.up), /\bUPDATE\b/i);
    }
});
