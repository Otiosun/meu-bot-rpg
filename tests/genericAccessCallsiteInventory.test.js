'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const audit = require('../scripts/auditGenericAccessCallsites');

test('reward review retry uses the canonical global facade and is inventoried precisely', () => {
    const file = path.resolve(__dirname, '../helpers/clover/raidRewardProposalIdempotencyService.js');
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /const \{ hasAccessPermission \} = require\('\.\/accessControlService'\)/);
    const calls = audit.scanFile(file);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].permission, 'raid.reward.review');
    assert.equal(calls[0].migrationStatus, 'protected_by_canonical_global_facade');
    assert.equal(audit.migrationStatus({ file: 'helpers/clover/unregisteredService.js' }), 'requires_migration');
});

test('runtime inventory retains zero unresolved calls and all ten canonical global guards', () => {
    const root = path.resolve(__dirname, '..');
    const summary = audit.summarize(audit.listFiles(root).flatMap(audit.scanFile));
    assert.equal(summary.unresolvedRuntimeCallsiteCount, 0);
    assert.equal(summary.protectedRuntimeCallsiteCount, 10);
});
