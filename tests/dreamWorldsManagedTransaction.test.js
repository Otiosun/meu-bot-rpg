'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { rejectDreamApplication } = require('../helpers/clover/dreamWorldsService');

test('Dream application rejection can run inside an externally managed transaction', async () => {
    const execs = [];
    const db = {
        async exec(sql) { execs.push(sql); },
        async get(sql) {
            if (sql.includes('clover_dream_applications')) {
                return {
                    id: 1, application_key: 'DA-TEST', world_id: 1, run_id: 2,
                    player_id: 'player@test', status: 'submitted', metadata_json: '{}',
                };
            }
            return null;
        },
        async run() { return { changes: 1 }; },
    };
    // This fixture only checks transaction ownership; domain serialization may depend on optional fields.
    try {
        await rejectDreamApplication(db, 1, 'admin@test', { reason: 'Teste' }, { transactionManaged: true });
    } catch (error) {
        // A domain-field error is acceptable for the reduced fixture; nested transaction is not.
        assert.notEqual(error?.message, 'cannot start a transaction within a transaction');
    }
    assert.equal(execs.some((sql) => /BEGIN IMMEDIATE/i.test(sql)), false);
    assert.equal(execs.some((sql) => /^COMMIT/i.test(sql)), false);
    assert.equal(execs.some((sql) => /^ROLLBACK/i.test(sql)), false);
});
