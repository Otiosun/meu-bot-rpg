'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ACTION_TYPES } = require('../helpers/clover/adminOperationContract');
const {
    buildAdminActionCoverage,
    unavailableAdminActionTypes,
} = require('../helpers/clover/adminActionCoverage');

test('admin action coverage reports every contract action exactly once', () => {
    const coverage = buildAdminActionCoverage();
    assert.equal(coverage.length, ACTION_TYPES.length);
    assert.deepEqual(
        [...new Set(coverage.map((entry) => entry.type))].sort(),
        [...ACTION_TYPES].sort()
    );
    for (const entry of coverage) {
        assert.equal(entry.available, entry.preview && entry.apply);
    }
});

test('title actions are executable and unavailable actions stay explicit', () => {
    const coverage = buildAdminActionCoverage();
    for (const type of ['player.title.grant', 'player.title.remove']) {
        const entry = coverage.find((item) => item.type === type);
        assert.equal(entry?.available, true, type);
    }
    const unavailable = unavailableAdminActionTypes();
    for (const type of unavailable) {
        assert.equal(coverage.find((item) => item.type === type)?.available, false);
    }
});
