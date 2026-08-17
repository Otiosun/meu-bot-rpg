'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    openCloverDatabase,
    readPragmaScalar,
} = require('../helpers/clover/databaseConnection');
const {
    CORE_MIGRATIONS,
    LOW_RISK_COLUMN_TARGETS,
    MIGRATION_TABLE,
    columnExists,
    inspectCloverMigrationState,
    migrationChecksum,
    prepareCloverSchemaBeforeLegacy,
    runCloverSchemaMigrations,
} = require('../helpers/clover/schemaMigrationService');
const { criarBanco } = require('../database');

function tempDatabasePath(t, name = 'database.sqlite') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-phase2-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, name);
}

async function createLowRiskBaseTables(db, { includeColumns = false } = {}) {
    await db.exec(`
        CREATE TABLE clover_character_stats (
            id INTEGER PRIMARY KEY${includeColumns ? ', ph_accumulated INTEGER DEFAULT 0, ph_available INTEGER DEFAULT 0' : ''}
        );
        CREATE TABLE clover_box_openings (
            id INTEGER PRIMARY KEY${includeColumns ? ', roll_basis_points INTEGER DEFAULT NULL' : ''}
        );
        CREATE TABLE clover_inventory_reservations (
            id INTEGER PRIMARY KEY${includeColumns ? ', expires_at TEXT DEFAULT NULL' : ''}
        );
        CREATE TABLE clover_consumable_uses (
            id INTEGER PRIMARY KEY${includeColumns ? ', effect_category TEXT DEFAULT NULL' : ''}
        );
    `);
}

test('checksum da baseline 0001 permanece compatível com o ledger já versionado', () => {
    assert.equal(
        migrationChecksum(CORE_MIGRATIONS[0]),
        '20e6ea43f54973d8c59148d3076f337a42619db6a857557394c05f8b347ff0c2'
    );
});

test('0002 adiciona somente as cinco colunas de baixo risco e segunda execução é no-op', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createLowRiskBaseTables(db);

    const first = await runCloverSchemaMigrations(db);
    assert.equal(first.latestVersion, 2);
    assert.equal(first.appliedCount, 2);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 2);

    for (const target of LOW_RISK_COLUMN_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }

    const rows = await db.all(`SELECT version, migration_key FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => Number(row.version)), [1, 2]);

    const second = await runCloverSchemaMigrations(db);
    assert.equal(second.appliedCount, 0);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 2);
});

test('0002 é no-op de schema quando o bootstrap legado já criou as colunas', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createLowRiskBaseTables(db, { includeColumns: true });

    const before = await inspectCloverMigrationState(db);
    assert.equal(before.ledgerExists, false);
    const result = await runCloverSchemaMigrations(db);
    const after = await inspectCloverMigrationState(db);

    assert.equal(result.appliedCount, 2);
    assert.equal(after.userVersion, 2);
    assert.equal(after.applied.length, 2);
    assert.equal(after.schemaFingerprintMatchesLatest, true);
});

test('0002 falha fechado se uma tabela obrigatória não existe e preserva a baseline', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await db.exec(`
        CREATE TABLE clover_character_stats (id INTEGER PRIMARY KEY);
        CREATE TABLE clover_box_openings (id INTEGER PRIMARY KEY);
        CREATE TABLE clover_inventory_reservations (id INTEGER PRIMARY KEY);
    `);

    await assert.rejects(
        runCloverSchemaMigrations(db),
        (error) => error?.code === 'migration_precondition_failed' && error?.table === 'clover_consumable_uses'
    );

    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => Number(row.version)), [1]);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 1);
    assert.equal(await columnExists(db, 'clover_character_stats', 'ph_accumulated'), false);
});

test('checksumMaterial protege SQL/targets externos da migration', () => {
    const migration = CORE_MIGRATIONS[1];
    const altered = {
        ...migration,
        checksumMaterial: [...migration.checksumMaterial, { table: 'x', column: 'y', definition: 'TEXT' }],
    };
    assert.notEqual(migrationChecksum(altered), migrationChecksum(migration));
});

test('ledger fora de sequência falha fechado antes de aplicar novas migrations', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createLowRiskBaseTables(db);
    await runCloverSchemaMigrations(db);
    await db.run(`DELETE FROM ${MIGRATION_TABLE} WHERE version = 1`);

    await assert.rejects(
        runCloverSchemaMigrations(db),
        (error) => error?.code === 'migration_sequence_mismatch'
    );
});

test('user_version adulterado falha antes de qualquer nova aplicação', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createLowRiskBaseTables(db);
    await runCloverSchemaMigrations(db);
    await db.exec('PRAGMA user_version = 1');

    await assert.rejects(
        runCloverSchemaMigrations(db),
        (error) => error?.code === 'user_version_mismatch' && error?.expected === 2 && error?.observed === 1
    );
});

test('prepare pre-legacy não cria ledger em banco ainda não adotado', async (t) => {
    const db = await openCloverDatabase({ filename: tempDatabasePath(t) });
    t.after(() => db.close());
    await createLowRiskBaseTables(db);

    const result = await prepareCloverSchemaBeforeLegacy(db);
    assert.equal(result.baselineAdopted, false);
    assert.equal(result.migratedBeforeLegacy, false);
    const ledger = await db.get("SELECT name FROM sqlite_schema WHERE type='table' AND name=?", [MIGRATION_TABLE]);
    assert.equal(ledger, undefined);
});

test('banco com baseline 0001 aplica 0002 antes do legacy', async (t) => {
    const filename = tempDatabasePath(t);
    const seed = await openCloverDatabase({ filename });
    await createLowRiskBaseTables(seed);
    await runCloverSchemaMigrations(seed, { migrations: [CORE_MIGRATIONS[0]] });
    assert.equal(Number(await readPragmaScalar(seed, 'user_version')), 1);
    await seed.close();

    let legacyObservedMigratedSchema = false;
    const db = await criarBanco({
        openMigrationDatabase: (options) => openCloverDatabase({ ...options, filename }),
        createLegacyDatabase: async () => {
            const connection = await openCloverDatabase({ filename });
            legacyObservedMigratedSchema = await columnExists(connection, 'clover_character_stats', 'ph_accumulated');
            return connection;
        },
    });
    t.after(() => db.close());

    assert.equal(legacyObservedMigratedSchema, true);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 2);
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => Number(row.version)), [1, 2]);
});

test('bootstrap ainda não adotado preserva legacy-first e só então adota 0001+0002', async (t) => {
    const filename = tempDatabasePath(t);
    let legacyCalled = 0;
    let ledgerExistedBeforeLegacy = null;

    const db = await criarBanco({
        openMigrationDatabase: (options) => openCloverDatabase({ ...options, filename }),
        createLegacyDatabase: async () => {
            legacyCalled += 1;
            const connection = await openCloverDatabase({ filename });
            const ledger = await connection.get(
                "SELECT name FROM sqlite_schema WHERE type='table' AND name=?",
                [MIGRATION_TABLE]
            );
            ledgerExistedBeforeLegacy = Boolean(ledger);
            await createLowRiskBaseTables(connection);
            return connection;
        },
    });
    t.after(() => db.close());

    assert.equal(legacyCalled, 1);
    assert.equal(ledgerExistedBeforeLegacy, false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 2);
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => Number(row.version)), [1, 2]);
    for (const target of LOW_RISK_COLUMN_TARGETS) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }
});

test('pre-legacy incoerente falha fechado antes de chamar o bootstrap legado', async (t) => {
    const filename = tempDatabasePath(t);
    const seed = await openCloverDatabase({ filename });
    await createLowRiskBaseTables(seed);
    await runCloverSchemaMigrations(seed, { migrations: [CORE_MIGRATIONS[0]] });
    await seed.exec('PRAGMA user_version = 0');
    await seed.close();

    let legacyCalled = false;
    await assert.rejects(
        criarBanco({
            openMigrationDatabase: (options) => openCloverDatabase({ ...options, filename }),
            createLegacyDatabase: async () => {
                legacyCalled = true;
                return openCloverDatabase({ filename });
            },
        }),
        (error) => error?.code === 'user_version_mismatch' && error?.expected === 1 && error?.observed === 0
    );
    assert.equal(legacyCalled, false);
});

test('user_version sem ledger aborta antes do legacy', async (t) => {
    const filename = tempDatabasePath(t);
    const seed = await openCloverDatabase({ filename });
    await createLowRiskBaseTables(seed);
    await seed.exec('PRAGMA user_version = 1');
    await seed.close();

    let legacyCalled = false;
    await assert.rejects(
        criarBanco({
            openMigrationDatabase: (options) => openCloverDatabase({ ...options, filename }),
            createLegacyDatabase: async () => {
                legacyCalled = true;
                return openCloverDatabase({ filename });
            },
        }),
        (error) => error?.code === 'migration_state_inconsistent' && error?.userVersion === 1
    );
    assert.equal(legacyCalled, false);
});
