'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    MIGRATION_FAMILIES,
    classify,
    migrationFamily,
    migrationStatus,
} = require('../scripts/auditGenericAccessCallsites');

test('Raid reward idempotency authorization is covered by canonical global permissions', () => {
    const runtime = {
        file: 'helpers/clover/raidRewardProposalIdempotencyService.js',
        rule: 'has_access_permission',
        permission: 'raid.reward.review',
    };
    assert.equal(classify(runtime), 'runtime_callsite');
    assert.equal(MIGRATION_FAMILIES[runtime.file], 'global_authorization');
    assert.equal(migrationFamily(runtime), 'global_authorization');
    assert.equal(migrationStatus(runtime), 'protected_by_canonical_global_facade');
});

test('new, unreviewed runtime permission readers remain blocked by the audit', () => {
    const unclassified = { file: 'helpers/clover/unreviewedPermissionReader.js' };
    assert.equal(classify(unclassified), 'runtime_callsite');
    assert.equal(migrationFamily(unclassified), 'unclassified_runtime');
    assert.equal(migrationStatus(unclassified), 'requires_migration');
});
