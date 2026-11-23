'use strict';

// S48: regression of read-only drift detection. Synthetic databases only.
// This does not claim that the migration runner currently blocks drift.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const {
    inspectCloverMigrationState,
    runCloverSchemaMigrations,
} = require('../helpers/clover/schemaMigrationService');

async function withDatabase(fn) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-s48-'));
    const filename = path.join(directory, 'synthetic.sqlite');
    const raw = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filename, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
            error => error ? reject(error) : resolve(db));
    });
    const db = {
        get: (sql, args = []) => new Promise((resolve, reject) =>
            raw.get(sql, args, (error, row) => error ? reject(error) : resolve(row))),
        all: (sql, args = []) => new Promise((resolve, reject) =>
            raw.all(sql, args, (error, rows) => error ? reject(error) : resolve(rows))),
        run: (sql, args = []) => new Promise((resolve, reject) =>
            raw.run(sql, args, error => error ? reject(error) : resolve())),
        exec: sql => new Promise((resolve, reject) =>
            raw.exec(sql, error => error ? reject(error) : resolve())),
    };
    try {
        await fn(db);
    } finally {
        await new Promise((resolve, reject) =>
            raw.close(error => error ? reject(error) : resolve()));
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

const migrations = [{
    version: 1,
    key: 's48_synthetic_baseline',
    description: 'Synthetic baseline for drift detection',
    async up() {},
}];

test('S48: inspection detects out-of-band DDL without modifying schema or ledger', async () => {
    await withDatabase(async db => {
        await db.exec('CREATE TABLE synthetic_domain (id INTEGER PRIMARY KEY)');
        const migrated = await runCloverSchemaMigrations(db, { migrations });
        assert.equal(migrated.appliedCount, 1);
        const clean = await inspectCloverMigrationState(db, { migrations });
        assert.equal(clean.schemaFingerprintMatchesLatest, true);

        await db.exec('ALTER TABLE synthetic_domain ADD COLUMN external_change TEXT');
        const beforeSchema = await db.all('SELECT type, name, sql FROM sqlite_schema ORDER BY name');
        const beforeVersion = await db.get('PRAGMA user_version');
        const beforeLedger = await db.all('SELECT * FROM clover_schema_migrations ORDER BY version');

        const drifted = await inspectCloverMigrationState(db, { migrations });
        assert.equal(drifted.schemaFingerprintMatchesLatest, false);
        assert.notEqual(drifted.currentSchemaFingerprint, drifted.latestRecordedFingerprint);
        assert.deepEqual(await db.all('SELECT type, name, sql FROM sqlite_schema ORDER BY name'), beforeSchema);
        assert.deepEqual(await db.get('PRAGMA user_version'), beforeVersion);
        assert.deepEqual(await db.all('SELECT * FROM clover_schema_migrations ORDER BY version'), beforeLedger);
    });
});
