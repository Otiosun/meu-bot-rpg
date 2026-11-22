'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const {
    MIGRATION_TABLE,
    runCloverSchemaMigrations,
    inspectCloverMigrationState,
} = require('../helpers/clover/schemaMigrationService');

function open(filename) {
    return new Promise((resolve, reject) => {
        const raw = new sqlite3.Database(filename, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (error) => {
            if (error) return reject(error);
            resolve({
                get: (sql, args = []) => new Promise((ok, fail) =>
                    raw.get(sql, args, (err, row) => err ? fail(err) : ok(row))),
                all: (sql, args = []) => new Promise((ok, fail) =>
                    raw.all(sql, args, (err, rows) => err ? fail(err) : ok(rows))),
                run: (sql, args = []) => new Promise((ok, fail) =>
                    raw.run(sql, args, function (err) { err ? fail(err) : ok(this.changes); })),
                exec: (sql) => new Promise((ok, fail) =>
                    raw.exec(sql, (err) => err ? fail(err) : ok())),
                close: () => new Promise((ok, fail) =>
                    raw.close((err) => err ? fail(err) : ok())),
            });
        });
    });
}

async function withSyntheticDb(callback) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-s39-'));
    const filename = path.join(directory, 'synthetic.sqlite');
    let db;
    try {
        db = await open(filename);
        await callback(db);
    } finally {
        if (db) await db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

const migrations = [{
    version: 1,
    key: 's39_synthetic_baseline',
    description: 'synthetic no-op baseline',
    async up() {},
}];

test('real sqlite3: direct runner refuses orphan version without creating ledger', async () => {
    await withSyntheticDb(async (db) => {
        await db.exec('CREATE TABLE synthetic_domain (id INTEGER PRIMARY KEY)');
        await db.exec('PRAGMA user_version = 7');
        const before = await db.all('SELECT type, name, sql FROM sqlite_schema ORDER BY name');
        await assert.rejects(
            runCloverSchemaMigrations(db, { migrations }),
            (error) => error.code === 'migration_state_inconsistent' && error.userVersion === 7
        );
        assert.deepEqual(await db.all('SELECT type, name, sql FROM sqlite_schema ORDER BY name'), before);
        assert.equal((await db.get('PRAGMA user_version')).user_version, 7);
        assert.equal((await db.get(
            "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = ?", [MIGRATION_TABLE]
        )).n, 0);
    });
});

test('real sqlite3: baseline migration is transactional, persistent and idempotent', async () => {
    await withSyntheticDb(async (db) => {
        await db.exec('CREATE TABLE synthetic_domain (id INTEGER PRIMARY KEY)');
        const first = await runCloverSchemaMigrations(db, { migrations });
        assert.equal(first.appliedCount, 1);
        assert.equal((await db.get('PRAGMA user_version')).user_version, 1);
        const state = await inspectCloverMigrationState(db, { migrations });
        assert.equal(state.applied.length, 1);
        assert.equal(state.schemaFingerprintMatchesLatest, true);
        const second = await runCloverSchemaMigrations(db, { migrations });
        assert.equal(second.appliedCount, 0);
        assert.equal((await db.get('SELECT COUNT(*) AS n FROM ' + MIGRATION_TABLE)).n, 1);
        assert.equal((await db.get('PRAGMA user_version')).user_version, 1);
    });
});
