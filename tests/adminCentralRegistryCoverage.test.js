'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    auditAdminCentralCoverage,
    getAdminCentralRegistry,
} = require('../helpers/clover/adminCentralRegistryService');
const { getAdminOperationExecutors } = require('../helpers/clover/adminOperationRegistry');

test('central registry materializes every canonical executor without unknown domains', () => {
    const executors = getAdminOperationExecutors();
    const registry = getAdminCentralRegistry(executors);
    assert.equal(registry.length, Object.keys(executors).length);
    assert.ok(registry.some((entry) => entry.operationKey === 'resource.adjust' && entry.domain === 'resources'));
    assert.ok(registry.some((entry) => entry.operationKey === 'market.listing.cancel' && entry.domain === 'market'));
    assert.ok(registry.some((entry) => entry.operationKey === 'system.shop.catalog.version.create' && entry.domain === 'system'));
});

test('central registry coverage has no contract-only or registry drift', () => {
    const coverage = auditAdminCentralCoverage(getAdminOperationExecutors());
    assert.deepEqual(coverage.contractOnly, []);
    assert.deepEqual(coverage.missingRegistry, []);
    assert.deepEqual(coverage.staleRegistry, []);
});
