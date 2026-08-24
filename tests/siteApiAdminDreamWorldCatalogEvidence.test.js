'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { canonicalRuntimeDescriptors } = require('../helpers/clover/routeSourceAudit');
const { auditCriticalContractEvidence, buildCriticalContractEvidence } = require('../helpers/clover/siteApiCriticalContractEvidence');
const { auditPublicContracts, isCriticalPublicDescriptor } = require('../helpers/clover/siteApiContractAudit');
const { __test } = require('../helpers/clover/siteApiHandlerBoundaryProbes');

async function auditDreamCatalog(overrides = {}, evidence) {
    const descriptors = canonicalRuntimeDescriptors();
    const captures = await __test.runAdminDreamWorldCatalogAndFragmentProbes();
    return auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, evidence, { captures: captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })), registry: auditPublicContracts(descriptors).registry });
}

test('F7 Dream Worlds admin catalog and fragments capture eight real disposable-SQLite operations', async () => {
    const audit = await auditDreamCatalog();
    assert.deepEqual(audit.proven.filter((id) => id.startsWith('admin.dream-worlds.') && (id.includes('fragments') || ['admin.dream-worlds.list', 'admin.dream-worlds.create', 'admin.dream-worlds.acquisition.update', 'admin.dream-worlds.status.transition'].includes(id))), [
        'admin.dream-worlds.list', 'admin.dream-worlds.create', 'admin.dream-worlds.acquisition.update', 'admin.dream-worlds.status.transition', 'admin.dream-worlds.fragments.list', 'admin.dream-worlds.fragments.create', 'admin.dream-worlds.fragments.update', 'admin.dream-worlds.fragments.grant',
    ]);
});

test('F7 Dream Worlds catalog evidence rejects path, response and family drift', async () => {
    const reason = (audit, id) => audit.unproven.find((entry) => entry.descriptorId === id)?.reason;
    assert.equal(reason(await auditDreamCatalog({ 'admin-dream-fragment-grant': { request: { method: 'POST', url: '/admin/dream-worlds/fragments/f/update', body: { playerId: 'x', status: 'active', reason: 'x' } } } }), 'admin.dream-worlds.fragments.grant'), 'path_schema_mismatch');
    assert.equal(reason(await auditDreamCatalog({ 'admin-dream-world-acquisition': { payload: { ok: true, world: {} } } }), 'admin.dream-worlds.acquisition.update'), 'real_response_schema_mismatch');
    const descriptors = canonicalRuntimeDescriptors();
    const evidence = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor).map((entry) => entry.descriptorId === 'admin.dream-worlds.create' ? { ...entry, familyId: 'wrong-dream-family' } : entry);
    assert.equal(reason(await auditDreamCatalog({}, evidence), 'admin.dream-worlds.create'), 'family_or_contract_misclassified');
});
