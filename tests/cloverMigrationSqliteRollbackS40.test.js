'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { MIGRATION_TABLE, runCloverSchemaMigrations } =
    require('../helpers/clover/schemaMigrationService');

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

test('real sqlite3: failed migration rolls back domain DDL, rows and version across reopen', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-s40-'));
    const filename = path.join(directory, 'rollback.sqlite');
    let db;
    try {
        db = await open(filename);
        await db.exec('CREATE TABLE stable_domain (id INTEGER PRIMARY KEY)');
        const migrations = [{
            version: 1,
            key: 's40_synthetic_failure',
            async up(connection) {
                await connection.exec('CREATE TABLE should_rollback (id INTEGER PRIMARY KEY)');
                await connection.run('INSERT INTO stable_domain (id) VALUES (?)', [42]);
                throw new Error('synthetic_migration_failure');
            },
        }];
        await assert.rejects(
            runCloverSchemaMigrations(db, { migrations }),
            /synthetic_migration_failure/
        );
        await db.close();
        db = null;

        // A new connection proves durability of the rollback, not just an in-memory view.
        db = await open(filename);
        assert.equal((await db.get('PRAGMA user_version')).user_version, 0);
        assert.equal((await db.get(
            "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name='should_rollback'"
        )).n, 0);
        assert.equal((await db.get('SELECT COUNT(*) AS n FROM stable_domain')).n, 0);
        assert.equal((await db.get('SELECT COUNT(*) AS n FROM ' + MIGRATION_TABLE)).n, 0);
    } finally {
        if (db) await db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
