'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    assertAdminActionCoverageComplete,
    buildAdminActionCoverage,
    unavailableAdminActionTypes,
} = require('../helpers/clover/adminActionCoverage');

test('every Central ADM contract action has preview and apply executors', () => {
    const coverage = buildAdminActionCoverage();
    assert.ok(coverage.length > 0, 'coverage manifest must not be empty');
    assert.deepEqual(unavailableAdminActionTypes(), []);
    assert.equal(assertAdminActionCoverageComplete(), true);
    for (const entry of coverage) {
        assert.equal(entry.available, true, entry.type);
        assert.equal(entry.preview, true, entry.type + ': preview');
        assert.equal(entry.apply, true, entry.type + ': apply');
    }
});
