'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { canonicalRuntimeDescriptors } = require('../helpers/clover/routeSourceAudit');
const { auditCriticalContractEvidence, buildCriticalContractEvidence } = require('../helpers/clover/siteApiCriticalContractEvidence');
const { auditPublicContracts, isCriticalPublicDescriptor } = require('../helpers/clover/siteApiContractAudit');
const { runCriticalHandlerBoundaryProbes } = require('../helpers/clover/siteApiHandlerBoundaryProbes');

async function provedAudit(overrides = {}) {
    const descriptors = canonicalRuntimeDescriptors();
    const captures = (await runCriticalHandlerBoundaryProbes()).captures.map((capture) => ({ ...capture, ...overrides[capture.name] }));
    const registry = auditPublicContracts(descriptors).registry;
    return auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, undefined, { captures, registry });
}

test('F7 proves Raid Core only after correlating each capture to its exact descriptor and contract', async () => {
    const descriptors = canonicalRuntimeDescriptors();
    const audit = await provedAudit();
    assert.equal(audit.total, descriptors.filter(isCriticalPublicDescriptor).length);
    assert.deepEqual(audit.proven, ['raid.create', 'raid.condition.add', 'raid.reward.add', 'raid.host.add', 'admin.bootstrap', 'admin.operation-policies.read']);
    assert.equal(audit.evidenced, 6);
    assert.equal(audit.requestFamiliesEvidenced, 6);
    assert.equal(audit.responseFamiliesCaptured, 6);
    assert.deepEqual(audit.evidence.filter((entry) => entry.familyId).map((entry) => [entry.descriptorId, entry.contractId]), [
        ['raid.create', 'raid-create-v1'],
        ['raid.condition.add', 'raid-condition-add-v1'],
        ['raid.reward.add', 'raid-reward-add-v1'],
        ['raid.host.add', 'raid-host-v1'],
        ['admin.bootstrap', 'admin-bootstrap-v1'],
        ['admin.operation-policies.read', 'admin-operation-policies-v1'],
    ]);
});

test('F7 critical evidence fails closed when one semantic entry is absent', async () => {
    const descriptors = canonicalRuntimeDescriptors();
    const all = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor);
    const captures = (await runCriticalHandlerBoundaryProbes()).captures;
    const registry = auditPublicContracts(descriptors).registry;
    const audit = auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, all.filter((entry) => entry.descriptorId !== 'raid.create'), { captures, registry });
    assert.ok(audit.unevidenced.includes('raid.create'));
});

test('F7 semantic negatives reject body, path, response and family drift', async () => {
    const descriptors = canonicalRuntimeDescriptors();
    const registry = auditPublicContracts(descriptors).registry;
    const baseline = (await runCriticalHandlerBoundaryProbes()).captures;
    const read = async (overrides) => auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, undefined, { captures: baseline.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })), registry });
    assert.equal((await read({ 'raid-reward': { request: { method: 'POST', url: '/raids/probe-raid/rewards', body: { rewardType: 'pa' } } } })).unproven.find((entry) => entry.descriptorId === 'raid.reward.add').reason, 'body_mode_or_schema_mismatch');
    assert.equal((await read({ 'raid-condition': { request: { method: 'POST', url: '/raids/probe-raid/reward', body: { label: 'Probe Condition' } } } })).unproven.find((entry) => entry.descriptorId === 'raid.condition.add').reason, 'path_schema_mismatch');
    assert.equal((await read({ 'raid-create': { payload: { ok: true } } })).unproven.find((entry) => entry.descriptorId === 'raid.create').reason, 'real_response_schema_mismatch');
    const evidence = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor).map((entry) => entry.descriptorId === 'raid.create' ? { ...entry, familyId: 'wrong-family' } : entry);
    const family = auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, evidence, { captures: baseline, registry });
    assert.equal(family.unproven.find((entry) => entry.descriptorId === 'raid.create').reason, 'family_or_contract_misclassified');
});
