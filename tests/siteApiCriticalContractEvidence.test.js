'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { canonicalRuntimeDescriptors } = require('../helpers/clover/routeSourceAudit');
const { auditCriticalContractEvidence, buildCriticalContractEvidence } = require('../helpers/clover/siteApiCriticalContractEvidence');
const { auditPublicContracts, isCriticalPublicDescriptor } = require('../helpers/clover/siteApiContractAudit');
const { runCriticalHandlerBoundaryProbes } = require('../helpers/clover/siteApiHandlerBoundaryProbes');
const { validateDescriptorContractPayload } = require('../helpers/clover/siteApiContractShapes');

async function provedAudit(overrides = {}) {
    const descriptors = canonicalRuntimeDescriptors();
    const captures = (await runCriticalHandlerBoundaryProbes()).captures.map((capture) => ({ ...capture, ...overrides[capture.name] }));
    const registry = auditPublicContracts(descriptors).registry;
    return auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, undefined, { captures, registry });
}

test('F7 proves the accepted Raid/Admin prefixes and complete critical pre-reset cluster from real captures', async () => {
    const descriptors = canonicalRuntimeDescriptors();
    const audit = await provedAudit();
    assert.equal(audit.total, descriptors.filter(isCriticalPublicDescriptor).length);
    assert.deepEqual(audit.proven, [
        'prereset.future-character.read', 'prereset.future-character.write', 'prereset.future-character.submit',
        'prereset.return-points.balance', 'prereset.conversion.read', 'prereset.conversion.claim',
        'prereset.shop.catalog', 'prereset.shop.purchase', 'prereset.admin.review',
        'raid.create', 'raid.condition.add', 'raid.reward.add', 'raid.host.add', 'raid.host.revoke',
        'admin.bootstrap', 'admin.operation-policies.read',
    ]);
    assert.equal(audit.evidenced, 16);
    assert.equal(audit.requestFamiliesEvidenced, 16);
    assert.equal(audit.responseFamiliesCaptured, 16);
    assert.deepEqual(audit.evidence.filter((entry) => entry.familyId).map((entry) => [entry.descriptorId, entry.contractId]), [
        ['prereset.future-character.read', 'future-character-v1'],
        ['prereset.future-character.write', 'future-character-v1'],
        ['prereset.future-character.submit', 'future-character-v1'],
        ['prereset.return-points.balance', 'return-points-balance-v1'],
        ['prereset.conversion.read', 'conversion-v1'],
        ['prereset.conversion.claim', 'conversion-v1'],
        ['prereset.shop.catalog', 'reset-shop-catalog-v1'],
        ['prereset.shop.purchase', 'reset-shop-purchase-v1'],
        ['prereset.admin.review', 'future-character-review-v1'],
        ['raid.create', 'raid-create-v1'],
        ['raid.condition.add', 'raid-condition-add-v1'],
        ['raid.reward.add', 'raid-reward-add-v1'],
        ['raid.host.add', 'raid-host-v1'],
        ['raid.host.revoke', 'raid-host-v1'],
        ['admin.bootstrap', 'admin-bootstrap-v1'],
        ['admin.operation-policies.read', 'admin-operation-policies-v1'],
    ]);
});

test('F7 contract variants reject resource substitution and broad ACK fallback', () => {
    const descriptors = canonicalRuntimeDescriptors();
    const registry = auditPublicContracts(descriptors).registry;
    const revoke = descriptors.find((descriptor) => descriptor.id === 'raid.host.revoke');
    assert.equal(validateDescriptorContractPayload({ ...revoke, contractShapeId: 'raid-host-add-shape-v1' }, 'response', { ok: true }, registry).ok, false);
    const broadRegistry = { ...registry, 'raid-host-revoke-shape-v1': { ...registry['raid-host-revoke-shape-v1'], broad: true } };
    assert.ok(auditPublicContracts(descriptors, { registry: broadRegistry }).opaqueDtoLabelsCritical.includes('raid.host.revoke'));
    assert.equal(auditPublicContracts(descriptors).opaqueDtoLabelsCritical.includes('raid.host.revoke'), false);
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

test('F7 pre-reset contract variants fail closed for shape, body, response, family, method and broad fallback drift', async () => {
    const descriptors = canonicalRuntimeDescriptors();
    const registry = auditPublicContracts(descriptors).registry;
    const captures = (await runCriticalHandlerBoundaryProbes()).captures;
    const read = (overrides = {}, evidence = undefined, selectedRegistry = registry) => auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, evidence, {
        captures: captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })), registry: selectedRegistry,
    });
    const find = (audit, descriptorId) => audit.unproven.find((entry) => entry.descriptorId === descriptorId)?.reason;
    const all = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor);
    const wrongVariant = all.map((entry) => entry.descriptorId === 'prereset.future-character.write' ? { ...entry, contractShapeId: 'future-character-read-shape-v1' } : entry);
    assert.equal(find(read({}, wrongVariant), 'prereset.future-character.write'), 'family_or_contract_misclassified');
    assert.equal(find(read({ 'prereset-future-character-post': { request: { method: 'POST', url: '/pre-reset/future-character', body: { expectedRevision: 0 } } } }), 'prereset.future-character.write'), 'body_mode_or_schema_mismatch');
    assert.equal(find(read({ 'prereset-shop-purchase': { payload: { ok: true } } }), 'prereset.shop.purchase'), 'real_response_schema_mismatch');
    assert.equal(find(read({ 'prereset-conversion-read': { semanticFamily: 'wrong-family' } }), 'prereset.conversion.read'), 'capture_not_correlated');
    assert.equal(find(read({ 'prereset-future-character-put': { request: { method: 'POST', url: '/pre-reset/future-character', body: { expectedRevision: 1, draft: { name: 'Atualizado' } } } } }), 'prereset.future-character.write'), 'method_coverage_mismatch');
    const broadRegistry = { ...registry, 'future-character-write-shape-v1': { ...registry['future-character-write-shape-v1'], broad: true } };
    assert.ok(auditPublicContracts(descriptors, { registry: broadRegistry }).opaqueDtoLabelsCritical.includes('prereset.future-character.write'));
});
