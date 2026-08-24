'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { canonicalRuntimeDescriptors } = require('../helpers/clover/routeSourceAudit');
const { auditCriticalContractEvidence, buildCriticalContractEvidence } = require('../helpers/clover/siteApiCriticalContractEvidence');
const { auditPublicContracts, isCriticalPublicDescriptor } = require('../helpers/clover/siteApiContractAudit');
const { __test } = require('../helpers/clover/siteApiHandlerBoundaryProbes');

async function operationAudit(overrides = {}, evidence = undefined) {
    const descriptors = canonicalRuntimeDescriptors();
    const captures = await __test.runAdminOperationAndTraitProbes();
    return auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, evidence, {
        captures: captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })),
        registry: auditPublicContracts(descriptors).registry,
    });
}

test('F7 administrative Operation Kernel and trait descriptors have real disposable-SQLite captures', async () => {
    const audit = await operationAudit();
    assert.deepEqual(audit.proven.filter((id) => id === 'admin.operations.collection' || id.startsWith('admin.operation.') || id.startsWith('admin.trait')), [
        'admin.operations.collection',
        'admin.operation.detail',
        'admin.operation.simulate',
        'admin.operation.approve',
        'admin.operation.apply',
        'admin.operation.undo',
        'admin.traits.collection',
        'admin.trait.detail',
        'admin.operation.recovery',
    ]);
});

test('F7 administrative Operation Kernel evidence rejects body, path, response, family and method drift', async () => {
    const reason = (audit, id) => audit.unproven.find((entry) => entry.descriptorId === id)?.reason;
    assert.equal(reason(await operationAudit({
        'admin-operations-list': { request: { method: 'GET', url: '/admin/operations?q=descartável', body: {} } },
    }), 'admin.operations.collection'), 'body_mode_or_schema_mismatch');
    assert.equal(reason(await operationAudit({
        'admin-operation-simulate': { request: { method: 'POST', url: '/admin/operation/OP-A1B2C3/simulate', body: null } },
    }), 'admin.operation.simulate'), 'path_schema_mismatch');
    assert.equal(reason(await operationAudit({
        'admin-operation-apply': { payload: { ok: true, operation: {} } },
    }), 'admin.operation.apply'), 'real_response_schema_mismatch');
    assert.equal(reason(await operationAudit({
        'admin-operation-recovery-retry': { request: { method: 'GET', url: '/admin/operations/OP-A1B2C3/retry', body: null } },
    }), 'admin.operation.recovery'), 'path_schema_mismatch');
    const descriptors = canonicalRuntimeDescriptors();
    const evidence = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor).map((entry) => entry.descriptorId === 'admin.trait.detail'
        ? { ...entry, familyId: 'wrong-admin-trait-detail-family' }
        : entry);
    assert.equal(reason(await operationAudit({}, evidence), 'admin.trait.detail'), 'family_or_contract_misclassified');
});
