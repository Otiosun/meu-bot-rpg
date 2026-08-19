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
    tableExists,
    runCloverSchemaMigrations,
} = require('../helpers/clover/schemaMigrationService');
const {
    RAID_V2_COLUMNS_KEY,
    RAID_V2_COLUMNS_MIGRATION,
    RAID_V2_COLUMNS_TARGETS,
    RAID_V2_COLUMNS_VERSION,
    RAID_V2_MONTH_TIME_ZONE,
    raidV2MigrationMonthKey,
} = require('../helpers/clover/schemaMigrationCatalog');

async function openTestDatabase(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0021-raid-v2-'));
    const filename = path.join(dir, 'database.sqlite');
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return db;
}

async function createV1RaidSchema(db) {
    await db.exec(`
        CREATE TABLE clover_raids (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            raid_key TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'missao',
            description TEXT DEFAULT NULL,
            location TEXT DEFAULT 'Capital de Clover',
            status TEXT NOT NULL DEFAULT 'lobby',
            owner_player_id TEXT NOT NULL,
            max_players INTEGER NOT NULL DEFAULT 12,
            salary_eligible INTEGER NOT NULL DEFAULT 1,
            rules_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            started_at TEXT DEFAULT NULL,
            finalization_at TEXT DEFAULT NULL,
            completed_at TEXT DEFAULT NULL,
            cancelled_at TEXT DEFAULT NULL,
            cancelled_by TEXT DEFAULT NULL,
            cancellation_reason TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        );
        CREATE TABLE clover_raid_participants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            raid_id INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'joined',
            joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
            joined_via TEXT DEFAULT 'site',
            removed_at TEXT DEFAULT NULL,
            removed_by TEXT DEFAULT NULL,
            removal_reason TEXT DEFAULT NULL,
            snapshot_json TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL,
            UNIQUE (raid_id, player_id)
        );
    `);
}

async function createV2RaidSchema(db) {
    await createV1RaidSchema(db);
    for (const target of RAID_V2_COLUMNS_TARGETS) {
        await db.exec(`ALTER TABLE clover_raids ADD COLUMN ${target.column} ${target.definition}`);
    }
}

async function run0021(db) {
    return runCloverSchemaMigrations(db, { migrations: [RAID_V2_COLUMNS_MIGRATION] });
}

async function ledgerVersions(db) {
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    return rows.map((row) => Number(row.version));
}

test('0021 possui exatamente 8 targets V2 apenas em clover_raids e exclui finalizacao, rewards e mensal', () => {
    assert.equal(RAID_V2_COLUMNS_VERSION, 21);
    assert.equal(RAID_V2_COLUMNS_KEY, '0021_raid_v2_columns');
    assert.equal(RAID_V2_MONTH_TIME_ZONE, 'America/Sao_Paulo');
    assert.equal(RAID_V2_COLUMNS_TARGETS.length, 8);
    const keys = RAID_V2_COLUMNS_TARGETS.map((target) => `${target.table}.${target.column}`);
    assert.equal(new Set(keys).size, 8);
    assert.deepEqual([...new Set(RAID_V2_COLUMNS_TARGETS.map((target) => target.table))], ['clover_raids']);
    for (const forbidden of [
        'clover_raid_participants.finalization_status',
        'clover_raid_rewards.resource_key',
        'clover_raid_monthly_reservations.scope_key',
        'clover_raid_monthly_ledger.entry_key',
    ]) {
        assert.equal(keys.includes(forbidden), false, forbidden);
    }
});

test('0021 classifica V1 puro como legado global nao retroativo e calcula mes SQLite/UTC em Sao Paulo', async (t) => {
    const db = await openTestDatabase(t);
    await createV1RaidSchema(db);
    const inserted = await db.run(
        `INSERT INTO clover_raids
         (raid_key, name, category, status, owner_player_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['v1-edge', 'V1 Edge', 'missao', 'completed', 'owner', '2026-08-01 01:30:00', '2026-08-01 01:30:00']
    );

    assert.equal(raidV2MigrationMonthKey('2026-08-01 01:30:00'), '2026-07');

    const result = await run0021(db);
    assert.equal(result.latestVersion, 21);
    assert.equal(result.appliedCount, 1);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 21);
    assert.deepEqual(await ledgerVersions(db), [21]);

    for (const target of RAID_V2_COLUMNS_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, target.column);
    }

    const raid = await db.get('SELECT * FROM clover_raids WHERE id = ?', [inserted.lastID]);
    assert.equal(raid.category, 'missao');
    assert.equal(raid.category_key, 'evento_especial');
    assert.equal(raid.category_label, 'Evento especial');
    assert.equal(raid.scope_type, 'global');
    assert.equal(raid.scope_player_id, null);
    assert.equal(raid.scope_squad_key, null);
    assert.equal(raid.month_key, '2026-07');
    assert.equal(raid.counts_monthly, 0);
    assert.equal(raid.monthly_limit, null);

    const index = await db.get(
        "SELECT sql FROM sqlite_schema WHERE type='index' AND name='idx_clover_raids_monthly_scope'"
    );
    assert.ok(index);
    assert.equal(await columnExists(db, 'clover_raid_participants', 'finalization_status'), false);
    assert.equal(await tableExists(db, 'clover_raid_rewards'), false);
    assert.equal(await tableExists(db, 'clover_raid_monthly_reservations'), false);
    assert.equal(await tableExists(db, 'clover_raid_monthly_ledger'), false);
});

test('0021 falha fechado para created_at nao deterministico e reverte as 8 colunas', async (t) => {
    const db = await openTestDatabase(t);
    await createV1RaidSchema(db);
    await db.run(
        `INSERT INTO clover_raids
         (raid_key, name, category, status, owner_player_id, created_at)
         VALUES ('bad-date', 'Bad Date', 'missao', 'lobby', 'owner', 'data-invalida')`
    );

    await assert.rejects(
        run0021(db),
        (error) => error?.code === 'raid_v2_month_mapping_required' && error?.raidId === 1
    );
    assert.equal(await columnExists(db, 'clover_raids', 'category_key'), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
    assert.deepEqual(await ledgerVersions(db), []);
});

test('0021 preserva linha V2 valida de esquadrao e apenas garante o indice', async (t) => {
    const db = await openTestDatabase(t);
    await createV2RaidSchema(db);
    const inserted = await db.run(
        `INSERT INTO clover_raids
         (raid_key, name, category, status, owner_player_id, created_at,
          category_key, category_label, scope_type, scope_squad_key,
          month_key, counts_monthly, monthly_limit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            'v2-squad', 'V2 Squad', 'missao_esquadrao', 'cancelled', 'owner',
            '2026-08-03 19:30:26', 'missao_esquadrao', 'Missao de esquadrao',
            'squad', 'mephistopolis', '2026-08', 1, 2,
        ]
    );
    const before = await db.get('SELECT * FROM clover_raids WHERE id = ?', [inserted.lastID]);

    await run0021(db);

    const after = await db.get('SELECT * FROM clover_raids WHERE id = ?', [inserted.lastID]);
    assert.deepEqual(after, before);
    assert.ok(await db.get(
        "SELECT 1 AS found FROM sqlite_schema WHERE type='index' AND name='idx_clover_raids_monthly_scope'"
    ));
});

test('0021 unifica missao_desenvolvimento player-scoped em saga_pessoal sem tocar mensal externo', async (t) => {
    const db = await openTestDatabase(t);
    await createV2RaidSchema(db);
    await db.run(
        `INSERT INTO clover_raids
         (raid_key, name, category, status, owner_player_id, created_at,
          category_key, category_label, scope_type, scope_player_id,
          month_key, counts_monthly, monthly_limit)
         VALUES ('dev-old', 'Dev Old', 'missao_desenvolvimento', 'completed', 'owner',
                 '2026-08-10 12:00:00', 'missao_desenvolvimento', 'Missao de desenvolvimento',
                 'player', 'player-1', '2026-08', 1, 7)`
    );

    await run0021(db);
    const row = await db.get("SELECT * FROM clover_raids WHERE raid_key='dev-old'");
    assert.equal(row.category, 'saga_pessoal');
    assert.equal(row.category_key, 'saga_pessoal');
    assert.equal(row.category_label, 'Saga individual / Missao de desenvolvimento');
    assert.equal(row.scope_type, 'player');
    assert.equal(row.scope_player_id, 'player-1');
    assert.equal(row.counts_monthly, 1);
    assert.equal(row.monthly_limit, 1);
    assert.equal(await tableExists(db, 'clover_raid_monthly_reservations'), false);
    assert.equal(await tableExists(db, 'clover_raid_monthly_ledger'), false);
});

test('0021 converte categoria mensal global nao contada em evento_especial', async (t) => {
    const db = await openTestDatabase(t);
    await createV2RaidSchema(db);
    await db.run(
        `INSERT INTO clover_raids
         (raid_key, name, category, status, owner_player_id, created_at,
          category_key, category_label, scope_type, month_key, counts_monthly, monthly_limit)
         VALUES ('legacy-global', 'Legacy Global', 'missao_esquadrao', 'completed', 'owner',
                 '2026-07-19 16:00:46', 'missao_esquadrao', 'Missao de esquadrao',
                 'global', '2026-07', 0, NULL)`
    );

    await run0021(db);
    const row = await db.get("SELECT * FROM clover_raids WHERE raid_key='legacy-global'");
    assert.equal(row.category, 'evento_especial');
    assert.equal(row.category_key, 'evento_especial');
    assert.equal(row.category_label, 'Evento especial');
    assert.equal(row.scope_type, 'global');
    assert.equal(row.counts_monthly, 0);
    assert.equal(row.monthly_limit, null);
});

test('0021 falha fechado para estado V2 parcial semanticamente incoerente', async (t) => {
    const db = await openTestDatabase(t);
    await createV2RaidSchema(db);
    await db.run(
        `INSERT INTO clover_raids
         (raid_key, name, category, status, owner_player_id, created_at,
          category_key, category_label, scope_type, scope_player_id,
          month_key, counts_monthly, monthly_limit)
         VALUES ('partial-v2', 'Partial V2', 'saga_pessoal', 'lobby', 'owner',
                 '2026-08-10 12:00:00', 'saga_pessoal',
                 'Saga individual / Missao de desenvolvimento',
                 'player', NULL, '2026-08', 0, NULL)`
    );
    const before = await db.get("SELECT * FROM clover_raids WHERE raid_key='partial-v2'");

    await assert.rejects(
        run0021(db),
        (error) => error?.code === 'raid_v2_state_mapping_required'
            && error?.raidId === 1
            && error?.reason === 'saga_pessoal_scope'
    );
    const after = await db.get("SELECT * FROM clover_raids WHERE raid_key='partial-v2'");
    assert.deepEqual(after, before);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
    assert.deepEqual(await ledgerVersions(db), []);
    assert.equal(await tableExists(db, 'clover_raid_monthly_reservations'), false);
});
