'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectCloverMigrationState } = require('../helpers/clover/schemaMigrationService');

test('inspection of an existing empty migration ledger performs no DDL or DML', async () => {
    const statements = [];
    const db = {
        async get(sql) {
            statements.push(['get', sql]);
            if (sql.includes('sqlite_schema')) return { found: 1 };
            if (sql === 'PRAGMA user_version') return { user_version: 0 };
            throw new Error('Unexpected get: ' + sql);
        },
        async all(sql) {
            statements.push(['all', sql]);
            if (sql.includes('FROM clover_schema_migrations')) return [];
            if (sql.includes('FROM sqlite_schema')) return [];
            throw new Error('Unexpected all: ' + sql);
        },
        async exec(sql) {
            statements.push(['exec', sql]);
            throw new Error('Inspection attempted DDL/transaction: ' + sql);
        },
        async run(sql) {
            statements.push(['run', sql]);
            throw new Error('Inspection attempted DML: ' + sql);
        },
    };
    const state = await inspectCloverMigrationState(db);
    assert.equal(state.ledgerExists, true);
    assert.deepEqual(state.applied, []);
    assert.equal(state.userVersion, 0);
    assert.equal(state.schemaFingerprintMatchesLatest, null);
    assert.match(state.currentSchemaFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(statements.some(([method]) => method === 'exec' || method === 'run'), false);
});
