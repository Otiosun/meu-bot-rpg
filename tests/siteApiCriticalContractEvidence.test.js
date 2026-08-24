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

test('F7 preserves accepted proof and adds real economy payment and market lifecycles', async () => {
    const descriptors = canonicalRuntimeDescriptors();
    const audit = await provedAudit();
    assert.equal(audit.total, descriptors.filter(isCriticalPublicDescriptor).length);
    assert.deepEqual(audit.proven.filter((id) => !id.includes('economy.')), [
        'prereset.future-character.read', 'prereset.future-character.write', 'prereset.future-character.submit',
        'prereset.return-points.balance', 'prereset.conversion.read', 'prereset.conversion.claim',
        'prereset.shop.catalog', 'prereset.shop.purchase', 'prereset.admin.review',
        'raid.create', 'raid.condition.add', 'raid.reward.add', 'raid.host.add', 'raid.host.revoke',
        'admin.bootstrap', 'admin.operation-policies.read',
    ]);
    assert.deepEqual(audit.proven.filter((id) => id.includes('economy.payments')), [
        'site.routeAuthed.post.economy.payments.preview',
        'site.routeAuthed.post.economy.payments.key.confirm',
        'site.routeAuthed.post.economy.payments.key.cancel',
    ]);
    assert.deepEqual(audit.proven.filter((id) => id.includes('economy.market')), [
        'site.routeAuthed.post.economy.market.listings',
        'site.routeAuthed.post.economy.market.listings.preview',
        'site.routeAuthed.post.economy.market.listings.key.cancel',
        'site.routeAuthed.post.economy.market.purchases.preview',
        'site.routeAuthed.post.economy.market.purchases.key.confirm',
        'site.routeAuthed.post.economy.market.purchases.key.cancel',
        'site.routeAuthed.post.economy.market.auctions.key.bids',
    ]);
    assert.deepEqual(audit.proven.filter((id) => id.includes('economy.trades')), [
        'site.routeAuthed.post.economy.trades',
        'site.routeAuthed.patch.economy.trades.key',
        'site.routeAuthed.post.economy.trades.key.confirm',
        'site.routeAuthed.post.economy.trades.key.cancel',
    ]);
    assert.deepEqual(audit.proven.filter((id) => id.includes('economy.weekly-requests')), [
        'site.routeAuthed.post.economy.weekly-requests',
        'site.routeAuthed.patch.economy.weekly-requests.key',
        'site.routeAuthed.post.economy.weekly-requests.key.cancel',
        'site.routeAuthed.post.economy.weekly-requests.key.deliver',
    ]);
    assert.equal(audit.evidenced, 34);
    assert.equal(audit.requestFamiliesEvidenced, 34);
    assert.equal(audit.responseFamiliesCaptured, 34);
    assert.deepEqual(audit.evidence.filter((entry) => entry.familyId && !entry.descriptorId.includes('economy.')).map((entry) => [entry.descriptorId, entry.contractId]), [
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
    assert.deepEqual(audit.evidence.filter((entry) => entry.descriptorId.includes('economy.payments')).map((entry) => [entry.descriptorId, entry.contractShapeId]), [
        ['site.routeAuthed.post.economy.payments.preview', 'site-economy-payments-preview-shape-v1'],
        ['site.routeAuthed.post.economy.payments.key.confirm', 'site-economy-payments-confirm-shape-v1'],
        ['site.routeAuthed.post.economy.payments.key.cancel', 'site-economy-payments-cancel-shape-v1'],
    ]);
    assert.deepEqual(audit.evidence.filter((entry) => entry.descriptorId.includes('economy.market')).map((entry) => [entry.descriptorId, entry.contractShapeId]), [
        ['site.routeAuthed.post.economy.market.listings', 'site-economy-market-listings-create-shape-v1'],
        ['site.routeAuthed.post.economy.market.listings.preview', 'site-economy-market-listings-preview-shape-v1'],
        ['site.routeAuthed.post.economy.market.listings.key.cancel', 'site-economy-market-listings-cancel-shape-v1'],
        ['site.routeAuthed.post.economy.market.purchases.preview', 'site-economy-market-purchases-preview-shape-v1'],
        ['site.routeAuthed.post.economy.market.purchases.key.confirm', 'site-economy-market-purchases-confirm-shape-v1'],
        ['site.routeAuthed.post.economy.market.purchases.key.cancel', 'site-economy-market-purchases-cancel-shape-v1'],
        ['site.routeAuthed.post.economy.market.auctions.key.bids', 'site-economy-market-auctions-bid-shape-v1'],
    ]);
    assert.deepEqual(audit.evidence.filter((entry) => entry.descriptorId.includes('economy.trades')).map((entry) => [entry.descriptorId, entry.contractShapeId]), [
        ['site.routeAuthed.post.economy.trades', 'site-economy-trades-create-shape-v1'],
        ['site.routeAuthed.patch.economy.trades.key', 'site-economy-trades-update-shape-v1'],
        ['site.routeAuthed.post.economy.trades.key.confirm', 'site-economy-trades-confirm-shape-v1'],
        ['site.routeAuthed.post.economy.trades.key.cancel', 'site-economy-trades-cancel-shape-v1'],
    ]);
    assert.deepEqual(audit.evidence.filter((entry) => entry.descriptorId.includes('economy.weekly-requests')).map((entry) => [entry.descriptorId, entry.contractShapeId]), [
        ['site.routeAuthed.post.economy.weekly-requests', 'site-economy-weekly-requests-create-shape-v1'],
        ['site.routeAuthed.patch.economy.weekly-requests.key', 'site-economy-weekly-requests-update-shape-v1'],
        ['site.routeAuthed.post.economy.weekly-requests.key.cancel', 'site-economy-weekly-requests-cancel-shape-v1'],
        ['site.routeAuthed.post.economy.weekly-requests.key.deliver', 'site-economy-weekly-requests-deliver-shape-v1'],
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

test('F7 economy payment evidence rejects path, body, response and contract-shape drift', async () => {
    const descriptors = canonicalRuntimeDescriptors();
    const registry = auditPublicContracts(descriptors).registry;
    const captures = (await runCriticalHandlerBoundaryProbes()).captures;
    const read = (overrides = {}, evidence = undefined) => auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, evidence, {
        captures: captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })), registry,
    });
    const reason = (audit, id) => audit.unproven.find((entry) => entry.descriptorId === id)?.reason;
    assert.equal(reason(read({ 'economy-payment-preview': { request: { method: 'POST', url: '/economy/payments/preview', body: { recipientId: 'recipient', amount: 10 } } } }), 'site.routeAuthed.post.economy.payments.preview'), 'body_mode_or_schema_mismatch');
    assert.equal(reason(read({ 'economy-payment-confirm': { request: { method: 'POST', url: '/economy/payments/confirm/example', body: null } } }), 'site.routeAuthed.post.economy.payments.key.confirm'), 'path_schema_mismatch');
    assert.equal(reason(read({ 'economy-payment-cancel': { payload: { ok: true } } }), 'site.routeAuthed.post.economy.payments.key.cancel'), 'real_response_schema_mismatch');
    const evidence = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor).map((entry) => entry.descriptorId === 'site.routeAuthed.post.economy.payments.preview' ? { ...entry, contractShapeId: 'site-economy-payments-confirm-shape-v1' } : entry);
    assert.equal(reason(read({}, evidence), 'site.routeAuthed.post.economy.payments.preview'), 'family_or_contract_misclassified');
});

test('F7 market evidence rejects lifecycle body, path, response and family drift', async () => {
    const descriptors = canonicalRuntimeDescriptors();
    const registry = auditPublicContracts(descriptors).registry;
    const captures = (await runCriticalHandlerBoundaryProbes()).captures;
    const read = (overrides = {}, evidence = undefined) => auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, evidence, {
        captures: captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })), registry,
    });
    const reason = (audit, id) => audit.unproven.find((entry) => entry.descriptorId === id)?.reason;
    assert.equal(reason(read({ 'economy-market-listing-create': { request: { method: 'POST', url: '/economy/market/listings', body: { inventoryItemId: 1 } } } }), 'site.routeAuthed.post.economy.market.listings'), 'body_mode_or_schema_mismatch');
    assert.equal(reason(read({ 'economy-market-purchase-confirm': { request: { method: 'POST', url: '/economy/market/purchases/confirm/example', body: null } } }), 'site.routeAuthed.post.economy.market.purchases.key.confirm'), 'path_schema_mismatch');
    assert.equal(reason(read({ 'economy-market-auction-bid': { payload: { ok: true } } }), 'site.routeAuthed.post.economy.market.auctions.key.bids'), 'real_response_schema_mismatch');
    const evidence = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor).map((entry) => entry.descriptorId === 'site.routeAuthed.post.economy.market.purchases.preview' ? { ...entry, familyId: 'wrong-market-family' } : entry);
    assert.equal(reason(read({}, evidence), 'site.routeAuthed.post.economy.market.purchases.preview'), 'family_or_contract_misclassified');
});

test('F7 secure trade evidence rejects lifecycle body, path, response and family drift', async () => {
    const descriptors = canonicalRuntimeDescriptors();
    const registry = auditPublicContracts(descriptors).registry;
    const captures = (await runCriticalHandlerBoundaryProbes()).captures;
    const read = (overrides = {}, evidence = undefined) => auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, evidence, {
        captures: captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })), registry,
    });
    const reason = (audit, id) => audit.unproven.find((entry) => entry.descriptorId === id)?.reason;
    assert.equal(reason(read({ 'economy-trade-create': { request: { method: 'POST', url: '/economy/trades', body: { targetId: 'target' } } } }), 'site.routeAuthed.post.economy.trades'), 'body_mode_or_schema_mismatch');
    assert.equal(reason(read({ 'economy-trade-update': { request: { method: 'PATCH', url: '/economy/trades', body: { items: [], yulls: 0 } } } }), 'site.routeAuthed.patch.economy.trades.key'), 'path_schema_mismatch');
    assert.equal(reason(read({ 'economy-trade-confirm-final': { payload: { ok: true, trade: {} } } }), 'site.routeAuthed.post.economy.trades.key.confirm'), 'real_response_schema_mismatch');
    const evidence = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor).map((entry) => entry.descriptorId === 'site.routeAuthed.post.economy.trades.key.cancel' ? { ...entry, familyId: 'wrong-trade-family' } : entry);
    assert.equal(reason(read({}, evidence), 'site.routeAuthed.post.economy.trades.key.cancel'), 'family_or_contract_misclassified');
});

test('F7 weekly request evidence rejects role-bound body, path, response and family drift', async () => {
    const descriptors = canonicalRuntimeDescriptors();
    const registry = auditPublicContracts(descriptors).registry;
    const captures = (await runCriticalHandlerBoundaryProbes()).captures;
    const read = (overrides = {}, evidence = undefined) => auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, evidence, {
        captures: captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })), registry,
    });
    const reason = (audit, id) => audit.unproven.find((entry) => entry.descriptorId === id)?.reason;
    assert.equal(reason(read({ 'economy-weekly-request-create': { request: { method: 'POST', url: '/economy/weekly-requests', body: { pricePercent: 100 } } } }), 'site.routeAuthed.post.economy.weekly-requests'), 'body_mode_or_schema_mismatch');
    assert.equal(reason(read({ 'economy-weekly-request-update': { request: { method: 'PATCH', url: '/economy/weekly-requests', body: { pricePercent: 110 } } } }), 'site.routeAuthed.patch.economy.weekly-requests.key'), 'path_schema_mismatch');
    assert.equal(reason(read({ 'economy-weekly-request-deliver': { payload: { ok: true, request: {} } } }), 'site.routeAuthed.post.economy.weekly-requests.key.deliver'), 'real_response_schema_mismatch');
    const evidence = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor).map((entry) => entry.descriptorId === 'site.routeAuthed.post.economy.weekly-requests.key.cancel' ? { ...entry, familyId: 'wrong-weekly-family' } : entry);
    assert.equal(reason(read({}, evidence), 'site.routeAuthed.post.economy.weekly-requests.key.cancel'), 'family_or_contract_misclassified');
});
