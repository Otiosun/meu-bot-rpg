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
    MIGRATION_TABLE,
    computeSchemaFingerprint,
    migrationChecksum,
    runCloverSchemaMigrations,
} = require('../helpers/clover/schemaMigrationService');

const BASELINE_MIGRATIONS = Object.freeze([CORE_MIGRATIONS[0]]);

function tempDatabasePath(_t, name = 'database.sqlite') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-repro-'));
    return path.join(dir, name);
}

function closeAndRemove(t, db, filename) {
    t.after(async () => {
        await db.close();
        fs.rmSync(path.dirname(filename), { recursive: true, force: true });
    });
}

test('conexão canônica ativa foreign_keys, WAL e busy_timeout', async (t) => {
    const filename = tempDatabasePath(t);
    const db = await openCloverDatabase({ filename });
    closeAndRemove(t, db, filename);

    assert.equal(Number(await readPragmaScalar(db, 'foreign_keys')), 1);
    assert.equal(String(await readPragmaScalar(db, 'journal_mode')).toLowerCase(), 'wal');
    assert.equal(Number(await readPragmaScalar(db, 'busy_timeout')), 10_000);
});

test('foreign_keys é realmente aplicado no caminho canônico', async (t) => {
    const filename = tempDatabasePath(t);
    const db = await openCloverDatabase({ filename });
    closeAndRemove(t, db, filename);

    await db.exec(`
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
    `);

    await assert.rejects(
        db.run('INSERT INTO child (id, parent_id) VALUES (1, 999)'),
        /FOREIGN KEY constraint failed/i
    );
});

test('baseline adoption cria ledger sem alterar fingerprint do domínio e é idempotente', async (t) => {
    const filename = tempDatabasePath(t);
    const db = await openCloverDatabase({ filename });
    closeAndRemove(t, db, filename);
    await db.exec('CREATE TABLE legacy_domain (id INTEGER PRIMARY KEY, value TEXT)');

    const before = await computeSchemaFingerprint(db);
    const first = await runCloverSchemaMigrations(db, { migrations: BASELINE_MIGRATIONS });
    const after = await computeSchemaFingerprint(db);
    const second = await runCloverSchemaMigrations(db, { migrations: BASELINE_MIGRATIONS });

    assert.equal(first.appliedCount, 1);
    assert.equal(second.appliedCount, 0);
    assert.equal(before, after);
    assert.equal(first.schemaFingerprint, after);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 1);

    const rows = await db.all(`SELECT * FROM ${MIGRATION_TABLE}`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].version, 1);
    assert.equal(rows[0].migration_key, CORE_MIGRATIONS[0].key);
    assert.equal(rows[0].checksum, migrationChecksum(CORE_MIGRATIONS[0]));
});

test('recheck dentro da transação tolera corrida já resolvida por outro startup', async (t) => {
    const filename = tempDatabasePath(t);
    const db = await openCloverDatabase({ filename });
    closeAndRemove(t, db, filename);
    await db.exec('CREATE TABLE legacy_domain (id INTEGER PRIMARY KEY)');
    await runCloverSchemaMigrations(db, { migrations: BASELINE_MIGRATIONS });

    const { applyMigration } = require('../helpers/clover/schemaMigrationService');
    const replay = await applyMigration(db, CORE_MIGRATIONS[0]);

    assert.equal(replay.applied, false);
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => row.version), [1]);
});

test('checksum divergente falha fechado', async (t) => {
    const filename = tempDatabasePath(t);
    const db = await openCloverDatabase({ filename });
    closeAndRemove(t, db, filename);
    await db.exec('CREATE TABLE legacy_domain (id INTEGER PRIMARY KEY)');
    await runCloverSchemaMigrations(db, { migrations: BASELINE_MIGRATIONS });
    await db.run(`UPDATE ${MIGRATION_TABLE} SET checksum = 'tampered' WHERE version = 1`);

    await assert.rejects(
        runCloverSchemaMigrations(db, { migrations: BASELINE_MIGRATIONS }),
        (error) => error?.code === 'migration_checksum_mismatch'
    );
});

test('migration com falha faz rollback de DDL e não grava ledger', async (t) => {
    const filename = tempDatabasePath(t);
    const db = await openCloverDatabase({ filename });
    closeAndRemove(t, db, filename);

    const migrations = [
        CORE_MIGRATIONS[0],
        {
            version: 2,
            key: '0002_intentional_failure',
            description: 'Teste transacional.',
            async up(connection) {
                await connection.exec('CREATE TABLE should_rollback (id INTEGER PRIMARY KEY)');
                throw new Error('boom');
            },
        },
    ];

    await assert.rejects(runCloverSchemaMigrations(db, { migrations }), /boom/);
    const table = await db.get("SELECT name FROM sqlite_schema WHERE type='table' AND name='should_rollback'");
    assert.equal(table, undefined);
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => row.version), [1]);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 1);
});
