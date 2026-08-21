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
    tableExists,
} = require('../helpers/clover/schemaMigrationService');
const {
    RAID_MONTHLY_LEDGER_TABLE_SQL,
    RAID_MONTHLY_PROGRESS_INDEXES,
    RAID_MONTHLY_PROGRESS_KEY,
    RAID_MONTHLY_PROGRESS_MIGRATION,
    RAID_MONTHLY_PROGRESS_VERSION,
    RAID_MONTHLY_RESERVATIONS_TABLE_SQL,
    inspectRaidMonthlyProgressSchemaState,
} = require('../helpers/clover/schemaMigrationCatalog');
async function openTestDatabase(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0024-raid-monthly-'));
    const filename = path.join(dir, 'database.sqlite');
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return db;
}

async function run0024(db) {
    return runCloverSchemaMigrations(db, {
        migrations: [RAID_MONTHLY_PROGRESS_MIGRATION],
    });
}

async function ledgerVersions(db) {
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    return rows.map((row) => Number(row.version));
}

async function createExactMonthlyFixture(db) {
    await db.exec(RAID_MONTHLY_RESERVATIONS_TABLE_SQL);
    await db.exec(RAID_MONTHLY_LEDGER_TABLE_SQL);
    for (const index of RAID_MONTHLY_PROGRESS_INDEXES) {
        await db.exec(index.sql);
    }
}

test('0024 define duas tabelas, quatro indices e politica estritamente nao retroativa', () => {
    assert.equal(RAID_MONTHLY_PROGRESS_VERSION, 24);
    assert.equal(RAID_MONTHLY_PROGRESS_KEY, '0024_raid_monthly_progress');
    assert.equal(RAID_MONTHLY_PROGRESS_INDEXES.length, 4);
    assert.deepEqual(
        RAID_MONTHLY_PROGRESS_INDEXES.map((entry) => entry.name),
        [
            'idx_clover_raid_monthly_reservation_scope',
            'idx_clover_raid_monthly_reservation_raid',
            'idx_clover_raid_monthly_ledger_scope',
            'idx_clover_raid_monthly_ledger_raid',
        ]
    );
    assert.match(RAID_MONTHLY_RESERVATIONS_TABLE_SQL, /scope_type IN \('player', 'squad'\)/);
    assert.match(RAID_MONTHLY_RESERVATIONS_TABLE_SQL, /status IN \('active', 'released', 'consumed'\)/);
    assert.match(
        RAID_MONTHLY_RESERVATIONS_TABLE_SQL,
        /UNIQUE \(raid_id, category_key, month_key, scope_type, scope_key\)/
    );
    assert.match(RAID_MONTHLY_LEDGER_TABLE_SQL, /entry_key TEXT NOT NULL UNIQUE/);
    assert.match(RAID_MONTHLY_LEDGER_TABLE_SQL, /amount INTEGER NOT NULL CHECK \(amount != 0\)/);
    assert.match(RAID_MONTHLY_LEDGER_TABLE_SQL, /kind IN \('completion', 'adjustment', 'reversal'\)/);
});

test('0024 em Monthly totalmente ausente cria shape canonico vazio e nao sintetiza historico', async (t) => {
    const db = await openTestDatabase(t);
    await db.exec(`
        CREATE TABLE clover_raids (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            raid_key TEXT,
            status TEXT,
            created_at TEXT
        )
    `);
    await db.run(
        `INSERT INTO clover_raids (raid_key, status, created_at)
         VALUES ('HIST-1', 'completed', '2026-06-10 12:00:00')`
    );

    const result = await run0024(db);
    assert.equal(result.latestVersion, 24);
    assert.equal(result.appliedCount, 1);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 24);
    assert.deepEqual(await ledgerVersions(db), [24]);

    const state = await inspectRaidMonthlyProgressSchemaState(db);
    assert.equal(state.kind, 'exact');
    assert.equal(state.indexValid, true);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_raid_monthly_reservations')).n, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_raid_monthly_ledger')).n, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_raids')).n, 1);

    await assert.rejects(
        db.run(
            `INSERT INTO clover_raid_monthly_reservations
             (raid_id, category_key, month_key, scope_type, scope_key, status)
             VALUES (1, 'saga_pessoal', '2026-08', 'guild', 'x', 'active')`
        )
    );
    await assert.rejects(
        db.run(
            `INSERT INTO clover_raid_monthly_ledger
             (entry_key, category_key, month_key, scope_type, scope_key, amount, kind)
             VALUES ('bad-zero', 'saga_pessoal', '2026-08', 'player', 'p1', 0, 'completion')`
        )
    );
});

test('0024 reconhece exatamente o shape canonico preexistente e faz no-op preservando rows e sequences', async (t) => {
    const db = await openTestDatabase(t);
    await createExactMonthlyFixture(db);

    await db.run(
        `INSERT INTO clover_raid_monthly_reservations
         (id, raid_id, category_key, month_key, scope_type, scope_key, status,
          release_reason, created_by, created_at, updated_at, released_at, metadata_json)
         VALUES (7, 5, 'missao_esquadrao', '2026-08', 'squad', 'mephistopolis',
                 'released', 'raid_cancelled_for_squad_p0', 'host',
                 '2026-08-10 10:00:00', '2026-08-10 11:00:00',
                 '2026-08-10 11:00:00', '{"snapshot":true}')`
    );
    await db.run(
        `INSERT INTO clover_raid_monthly_ledger
         (id, entry_key, raid_id, category_key, month_key, scope_type, scope_key,
          amount, kind, reason, created_by, created_at, metadata_json)
         VALUES (9, 'historic-ledger-9', 4, 'saga_pessoal', '2026-07',
                 'player', 'p9', 1, 'completion', 'historico',
                 'host', '2026-07-20 12:00:00', '{"historic":true}')`
    );
    await db.run(
        `UPDATE sqlite_sequence SET seq = 40 WHERE name = 'clover_raid_monthly_reservations'`
    );
    await db.run(
        `UPDATE sqlite_sequence SET seq = 60 WHERE name = 'clover_raid_monthly_ledger'`
    );

    const beforeReservation = await db.get(
        'SELECT * FROM clover_raid_monthly_reservations WHERE id = 7'
    );
    const beforeLedger = await db.get(
        'SELECT * FROM clover_raid_monthly_ledger WHERE id = 9'
    );
    const beforeTableSql = await db.all(
        `SELECT name, sql FROM sqlite_schema
         WHERE type='table' AND name IN ('clover_raid_monthly_reservations','clover_raid_monthly_ledger')
         ORDER BY name`
    );

    const result = await run0024(db);
    assert.equal(result.latestVersion, 24);
    assert.equal(result.appliedCount, 1);
    assert.deepEqual(
        await db.get('SELECT * FROM clover_raid_monthly_reservations WHERE id = 7'),
        beforeReservation
    );
    assert.deepEqual(
        await db.get('SELECT * FROM clover_raid_monthly_ledger WHERE id = 9'),
        beforeLedger
    );
    assert.deepEqual(
        await db.all(
            `SELECT name, sql FROM sqlite_schema
             WHERE type='table' AND name IN ('clover_raid_monthly_reservations','clover_raid_monthly_ledger')
             ORDER BY name`
        ),
        beforeTableSql
    );
    assert.equal(
        Number((await db.get(
            `SELECT seq FROM sqlite_sequence WHERE name='clover_raid_monthly_reservations'`
        )).seq),
        40
    );
    assert.equal(
        Number((await db.get(
            `SELECT seq FROM sqlite_sequence WHERE name='clover_raid_monthly_ledger'`
        )).seq),
        60
    );
    const state = await inspectRaidMonthlyProgressSchemaState(db);
    assert.equal(state.kind, 'exact');
    assert.equal(state.indexValid, true);
});

test('0024 aceita indice extra nao canonico sem remove-lo nem reescrever Monthly exato', async (t) => {
    const db = await openTestDatabase(t);
    await createExactMonthlyFixture(db);
    await db.exec(`
        CREATE INDEX custom_monthly_reason
        ON clover_raid_monthly_reservations (release_reason)
    `);

    await run0024(db);

    assert.ok(await db.get(
        `SELECT 1 AS found FROM sqlite_schema
         WHERE type='index' AND name='custom_monthly_reason'`
    ));
    const state = await inspectRaidMonthlyProgressSchemaState(db);
    assert.equal(state.kind, 'exact');
    assert.equal(state.indexValid, true);
});

test('0024 falha fechado se somente uma das duas tabelas Monthly existe', async (t) => {
    const db = await openTestDatabase(t);
    await db.exec(RAID_MONTHLY_RESERVATIONS_TABLE_SQL);

    await assert.rejects(
        run0024(db),
        (error) => error?.code === 'raid_monthly_schema_mapping_required'
            && error?.reason === 'partial_tables'
    );

    assert.equal(await tableExists(db, 'clover_raid_monthly_reservations'), true);
    assert.equal(await tableExists(db, 'clover_raid_monthly_ledger'), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
    assert.deepEqual(await ledgerVersions(db), []);
});

test('0024 falha fechado para table-shape Monthly incompatível sem reparar silenciosamente', async (t) => {
    const db = await openTestDatabase(t);
    const incompatibleReservations = RAID_MONTHLY_RESERVATIONS_TABLE_SQL.replace(
        "scope_type IN ('player', 'squad')",
        "scope_type IN ('player', 'guild')"
    );
    await db.exec(incompatibleReservations);
    await db.exec(RAID_MONTHLY_LEDGER_TABLE_SQL);

    await assert.rejects(
        run0024(db),
        (error) => error?.code === 'raid_monthly_schema_mapping_required'
            && error?.reason === 'table_shape'
    );

    const tableSql = (await db.get(
        `SELECT sql FROM sqlite_schema
         WHERE type='table' AND name='clover_raid_monthly_reservations'`
    )).sql;
    assert.match(tableSql, /'guild'/);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
    assert.deepEqual(await ledgerVersions(db), []);
});

test('0024 nao cria indice canonico ausente em Monthly preexistente exato', async (t) => {
    const db = await openTestDatabase(t);
    await createExactMonthlyFixture(db);
    await db.exec('DROP INDEX idx_clover_raid_monthly_ledger_raid');

    await assert.rejects(
        run0024(db),
        (error) => error?.code === 'raid_monthly_index_mapping_required'
            && error?.indexes?.some((entry) => entry.name === 'idx_clover_raid_monthly_ledger_raid')
    );

    assert.equal(
        await db.get(
            `SELECT 1 AS found FROM sqlite_schema
             WHERE type='index' AND name='idx_clover_raid_monthly_ledger_raid'`
        ),
        undefined
    );
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
});

test('0024 bloqueia indice canonico homonimo com definição errada', async (t) => {
    const db = await openTestDatabase(t);
    await createExactMonthlyFixture(db);
    await db.exec('DROP INDEX idx_clover_raid_monthly_reservation_raid');
    await db.exec(`
        CREATE INDEX idx_clover_raid_monthly_reservation_raid
        ON clover_raid_monthly_reservations (raid_id, id)
    `);

    await assert.rejects(
        run0024(db),
        (error) => error?.code === 'raid_monthly_index_mapping_required'
            && error?.indexes?.some((entry) => entry.name === 'idx_clover_raid_monthly_reservation_raid')
    );

    const state = await inspectRaidMonthlyProgressSchemaState(db);
    assert.equal(state.kind, 'exact');
    assert.equal(state.indexValid, false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
});

test('0024 bloqueia nome de indice canonico em outra tabela quando Monthly ainda esta ausente', async (t) => {
    const db = await openTestDatabase(t);
    await db.exec(`
        CREATE TABLE external_monthly_shadow (id INTEGER PRIMARY KEY, raid_id INTEGER);
        CREATE INDEX idx_clover_raid_monthly_reservation_raid
        ON external_monthly_shadow (raid_id, id);
    `);

    await assert.rejects(
        run0024(db),
        (error) => error?.code === 'raid_monthly_index_mapping_required'
    );

    assert.equal(await tableExists(db, 'clover_raid_monthly_reservations'), false);
    assert.equal(await tableExists(db, 'clover_raid_monthly_ledger'), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
});

test('0024 detecta estado armazenado inválido em shape exato e nao o normaliza', async (t) => {
    const db = await openTestDatabase(t);
    await createExactMonthlyFixture(db);
    await db.exec('PRAGMA ignore_check_constraints = ON');
    await db.run(
        `INSERT INTO clover_raid_monthly_ledger
         (entry_key, category_key, month_key, scope_type, scope_key, amount, kind)
         VALUES ('invalid-zero', 'saga_pessoal', '2026-08', 'player', 'p1', 0, 'completion')`
    );
    await db.exec('PRAGMA ignore_check_constraints = OFF');

    await assert.rejects(
        run0024(db),
        (error) => error?.code === 'raid_monthly_state_mapping_required'
            && error?.table === 'clover_raid_monthly_ledger'
            && error?.rowId === 1
    );

    assert.equal(
        Number((await db.get(
            `SELECT amount FROM clover_raid_monthly_ledger WHERE entry_key='invalid-zero'`
        )).amount),
        0
    );
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
    assert.deepEqual(await ledgerVersions(db), []);
});
