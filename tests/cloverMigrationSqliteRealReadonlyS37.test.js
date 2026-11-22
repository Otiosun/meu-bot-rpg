'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const {
    inspectCloverMigrationState,
    prepareCloverSchemaBeforeLegacy,
    MIGRATION_TABLE,
} = require('../helpers/clover/schemaMigrationService');

function openDatabase(filename, flags) {
    return new Promise((resolve, reject) => {
        const raw = new sqlite3.Database(filename, flags, (error) => {
            if (error) return reject(error);
            resolve({
                get: (sql, params = []) => new Promise((ok, fail) =>
                    raw.get(sql, params, (err, row) => err ? fail(err) : ok(row))),
                all: (sql, params = []) => new Promise((ok, fail) =>
                    raw.all(sql, params, (err, rows) => err ? fail(err) : ok(rows))),
                run: (sql, params = []) => new Promise((ok, fail) =>
                    raw.run(sql, params, function (err) { err ? fail(err) : ok({ changes: this.changes }); })),
                exec: (sql) => new Promise((ok, fail) =>
                    raw.exec(sql, (err) => err ? fail(err) : ok())),
                close: () => new Promise((ok, fail) =>
                    raw.close((err) => err ? fail(err) : ok())),
            });
        });
    });
}

async function withReadonlyDatabase(setup, check) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-s37-'));
    const filename = path.join(directory, 'synthetic.sqlite');
    let writer;
    let reader;
    try {
        writer = await openDatabase(filename, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
        await setup(writer);
        await writer.close();
        writer = null;
        reader = await openDatabase(filename, sqlite3.OPEN_READONLY);
        await check(reader, filename);
    } finally {
        if (reader) await reader.close();
        if (writer) await writer.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('real sqlite3: fresh season inspection works on a physically read-only database', async () => {
    await withReadonlyDatabase(async (db) => {
        await db.exec('CREATE TABLE synthetic_domain (id INTEGER PRIMARY KEY)');
    }, async (db) => {
        const before = await db.all("SELECT type, name, sql FROM sqlite_schema ORDER BY name");
        const state = await inspectCloverMigrationState(db);
        const preparation = await prepareCloverSchemaBeforeLegacy(db);
        const after = await db.all("SELECT type, name, sql FROM sqlite_schema ORDER BY name");
        assert.equal(state.ledgerExists, false);
        assert.equal(state.userVersion, 0);
        assert.equal(preparation.migratedBeforeLegacy, false);
        assert.deepEqual(after, before);
    });
});

test('real sqlite3: existing ledger inspection and pre-legacy preparation are read-only', async () => {
    await withReadonlyDatabase(async (db) => {
        await db.exec(`CREATE TABLE ${MIGRATION_TABLE} (
            version INTEGER PRIMARY KEY, migration_key TEXT NOT NULL UNIQUE,
            checksum TEXT NOT NULL, schema_fingerprint TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT NOT NULL DEFAULT '{}'
        )`);
    }, async (db) => {
        const before = await db.all("SELECT type, name, sql FROM sqlite_schema ORDER BY name");
        const state = await inspectCloverMigrationState(db);
        const preparation = await prepareCloverSchemaBeforeLegacy(db);
        assert.equal(state.ledgerExists, true);
        assert.deepEqual(state.applied, []);
        assert.equal(preparation.migratedBeforeLegacy, false);
        assert.deepEqual(await db.all("SELECT type, name, sql FROM sqlite_schema ORDER BY name"), before);
    });
});

test('real sqlite3: orphaned user_version fails without modifying the database', async () => {
    await withReadonlyDatabase(async (db) => {
        await db.exec('PRAGMA user_version = 3');
    }, async (db) => {
        await assert.rejects(
            prepareCloverSchemaBeforeLegacy(db),
            (error) => error.code === 'migration_state_inconsistent' && error.userVersion === 3
        );
        assert.equal((await db.get('PRAGMA user_version')).user_version, 3);
        assert.equal((await db.get(
            "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = ?", [MIGRATION_TABLE]
        )).n, 0);
    });
});
