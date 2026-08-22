'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    CRITICAL_TABLE_BOUNDARIES,
    assertCanonicalDataAuthority,
    auditCanonicalDataAuthority,
} = require('../scripts/auditCanonicalDataAuthority');

const repositoryRoot = path.join(__dirname, '..');

test('canonical data map classifies every current critical production SQL writer', () => {
    const audit = assertCanonicalDataAuthority(repositoryRoot);
    assert.deepEqual(audit.blockers, []);
    assert.ok(audit.mutations.length > 0);
    assert.equal(CRITICAL_TABLE_BOUNDARIES.clover_yulls_ledger.authority, 'helpers/clover/yullsService.js');
    assert.deepEqual(CRITICAL_TABLE_BOUNDARIES.clover_squad_memberships.writers, [
        'helpers/clover/squadMembershipService.js',
        'helpers/clover/squadMembershipTransitionService.js',
    ]);
    assert.deepEqual(CRITICAL_TABLE_BOUNDARIES.clover_exit_confirmations.writers, [
        'helpers/clover/communityExitManager.js',
    ]);
});

test('canonical data map rejects a new unclassified critical writer', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-data-authority-negative-'));
    try {
        const file = path.join(root, 'helpers', 'clover', 'parallelWriter.js');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "async function bad(db) { return db.run('UPDATE clover_yulls_ledger SET amount = 1'); }\n");
        const audit = auditCanonicalDataAuthority(root);
        assert.equal(audit.ok, false);
        assert.deepEqual(audit.blockers, [{
            code: 'unclassified_critical_data_writer',
            file: 'helpers/clover/parallelWriter.js',
            table: 'clover_yulls_ledger',
            fact: 'Yulls ledger entries',
        }]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
