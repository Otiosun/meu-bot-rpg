'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PRE_RESET_ENDPOINTS, getPublicSiteApiContract } = require('../helpers/clover/siteApiContractRegistry');
const { ACTION_CAPABILITIES, ACTION_TYPES } = require('../helpers/clover/adminOperationContract');
const { getAdminOperationExecutors } = require('../helpers/clover/adminOperationRegistry');
const { auditAdminCentralCoverage, getAdminCentralRegistry } = require('../helpers/clover/adminCentralRegistryService');

test('F7 public contract is versioned, explicit and does not expose database rows', () => {
    const contract = getPublicSiteApiContract();
    assert.equal(contract.version, 'v1');
    assert.equal(contract.mutationIdempotencyHeader, 'Idempotency-Key');
    assert.equal(contract.compatibility, 'additive-only-within-v1');
    assert.equal(PRE_RESET_ENDPOINTS.length, 11);
    assert.ok(PRE_RESET_ENDPOINTS.every((endpoint) => endpoint.dto && endpoint.area));
});

test('F9 registry covers real executors and derives canonical capabilities', () => {
    const executors = getAdminOperationExecutors();
    const registry = getAdminCentralRegistry(executors);
    const audit = auditAdminCentralCoverage(executors);
    assert.deepEqual(registry.map((entry) => entry.operationKey), Object.keys(executors).sort());
    assert.deepEqual(audit.missingRegistry, []);
    assert.deepEqual(audit.staleRegistry, []);
    assert.deepEqual([...ACTION_TYPES].filter((key) => !ACTION_CAPABILITIES[key]), []);
    assert.ok(registry.every((entry) => entry.capability === ACTION_CAPABILITIES[entry.operationKey] && entry.audit && entry.confirmation));
    assert.throws(() => getAdminCentralRegistry({ 'unknown.operation': {} }), /canonical capability/);
});
