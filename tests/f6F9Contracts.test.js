'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PRE_RESET_ENDPOINTS, getPublicSiteApiContract } = require('../helpers/clover/siteApiContractRegistry');
const { OPERATION_METADATA, getAdminCentralRegistry } = require('../helpers/clover/adminCentralRegistryService');

test('F7 public contract is versioned, explicit and does not expose database rows', () => {
    const contract = getPublicSiteApiContract();
    assert.equal(contract.version, 'v1');
    assert.equal(contract.mutationIdempotencyHeader, 'Idempotency-Key');
    assert.equal(contract.compatibility, 'additive-only-within-v1');
    assert.equal(PRE_RESET_ENDPOINTS.length, 11);
    assert.ok(PRE_RESET_ENDPOINTS.every((endpoint) => endpoint.dto && endpoint.area));
});

test('F9 registry is complete metadata and does not create a parallel RBAC authority', () => {
    const executors = Object.fromEntries(Object.keys(OPERATION_METADATA).map((key) => [key, {}]));
    const registry = getAdminCentralRegistry(executors);
    assert.equal(registry.length, Object.keys(executors).length);
    assert.ok(registry.every((entry) => entry.capability.startsWith('admin.') && entry.audit && entry.confirmation && entry.handlerReference === entry.operationKey));
    assert.throws(() => getAdminCentralRegistry({ 'unknown.operation': {} }), /lacks central metadata/);
});
