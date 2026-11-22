'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    inspectCloverMigrationState,
    prepareCloverSchemaBeforeLegacy,
    runCloverSchemaMigrations,
} = require('../helpers/clover/schemaMigrationService');

function readonlyDb(userVersion = 0) {
    const calls = [];
    return {
        calls,
        async get(sql, params) {
            calls.push(['get', sql, params]);
            if (sql.includes('sqlite_schema')) return undefined;
            if (sql === 'PRAGMA user_version') return { user_version: userVersion };
            throw new Error('Unexpected query: ' + sql);
        },
        async all(sql) {
            calls.push(['all', sql]);
            if (sql.includes('FROM sqlite_schema')) return [];
            throw new Error('Unexpected query: ' + sql);
        },
        async exec(sql) {
            calls.push(['exec', sql]);
            throw new Error('Read-only preflight attempted SQL write: ' + sql);
        },
        async run(sql) {
            calls.push(['run', sql]);
            throw new Error('Read-only preflight attempted SQL write: ' + sql);
        },
    };
}

test('inspecting a fresh season without a migration ledger is strictly read-only', async () => {
    const db = readonlyDb();
    const result = await inspectCloverMigrationState(db);
    assert.equal(result.ledgerExists, false);
    assert.equal(result.baselineAdopted, false);
    assert.equal(result.userVersion, 0);
    assert.deepEqual(result.applied, []);
    assert.match(result.currentSchemaFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(db.calls.some(([kind]) => kind === 'exec' || kind === 'run'), false);
});

test('pre-legacy preparation does not create tables in an empty new season', async () => {
    const db = readonlyDb();
    const result = await prepareCloverSchemaBeforeLegacy(db);
    assert.equal(result.migratedBeforeLegacy, false);
    assert.equal(result.appliedCount, 0);
    assert.equal(result.latestVersion, 0);
    assert.equal(db.calls.some(([kind]) => kind === 'exec' || kind === 'run'), false);
});

test('orphaned user_version is rejected before any DDL or transaction', async () => {
    const db = readonlyDb(3);
    await assert.rejects(
        prepareCloverSchemaBeforeLegacy(db),
        (error) => error.code === 'migration_state_inconsistent' && error.userVersion === 3
    );
    assert.equal(db.calls.some(([kind]) => kind === 'exec' || kind === 'run'), false);
});

test('direct migration runner rejects orphaned user_version before creating ledger', async () => {
    const db = readonlyDb(3);
    await assert.rejects(
        runCloverSchemaMigrations(db),
        (error) => error.code === 'migration_state_inconsistent' && error.userVersion === 3
    );
    assert.equal(db.calls.some(([kind]) => kind === 'exec' || kind === 'run'), false);
});
