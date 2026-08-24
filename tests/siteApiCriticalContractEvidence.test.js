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
        'admin.bootstrap', 'admin.players.search', 'admin.integrity.summary', 'admin.player.detail', 'admin.operation-policies.read',
        'admin.hooks.list', 'admin.hooks.schema', 'admin.hooks.assignments', 'admin.hooks.detail',
        'admin.command-center.inbox', 'admin.command-center.history',
        'admin.canonical-team.read', 'admin.canonical-team.change.create', 'admin.canonical-team.change.read',
        'admin.canonical-team.change.apply', 'admin.canonical-team.change.cancel', 'admin.canonical-team.change.undo',
        'admin.items.list', 'admin.items.detail', 'admin.rewards.list', 'admin.rewards.grants', 'admin.rewards.detail',
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
    assert.deepEqual(audit.proven.filter((id) => id.includes('economy.item-templates')), [
        'site.routeAuthed.post.economy.item-templates',
        'site.routeAuthed.patch.economy.item-templates.key',
        'site.routeAuthed.post.economy.item-templates.key.archive',
        'site.routeAuthed.post.economy.item-templates.key.grant',
    ]);
    assert.deepEqual(audit.proven.filter((id) => id.includes('economy.redemptions')), [
        'site.routeAuthed.post.economy.redemptions',
        'site.routeAuthed.post.economy.redemptions.key.cancel',
        'site.routeAuthed.post.economy.redemptions.key.approve',
        'site.routeAuthed.post.economy.redemptions.key.reject',
    ]);
    assert.deepEqual(audit.proven.filter((id) => id.includes('economy.titles') || id.includes('economy.initial-package')), [
        'site.routeAuthed.post.economy.titles.deactivate',
        'site.routeAuthed.post.economy.titles.key.activate',
        'site.routeAuthed.post.economy.initial-package',
    ]);
    assert.deepEqual(audit.proven.filter((id) => /economy\.(purchases|sales|repairs|consumables)/.test(id)), [
        'site.routeAuthed.post.economy.purchases.preview',
        'site.routeAuthed.post.economy.purchases.key.confirm',
        'site.routeAuthed.post.economy.purchases.key.cancel',
        'site.routeAuthed.post.economy.sales.preview',
        'site.routeAuthed.post.economy.sales.key.confirm',
        'site.routeAuthed.post.economy.repairs.preview',
        'site.routeAuthed.post.economy.repairs.key.confirm',
        'site.routeAuthed.post.economy.consumables.itemId.use',
    ]);
    assert.equal(audit.evidenced, 73);
    assert.equal(audit.requestFamiliesEvidenced, 73);
    assert.equal(audit.responseFamiliesCaptured, 73);
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
        ['admin.players.search', 'admin-player-search-v1'],
        ['admin.integrity.summary', 'admin-integrity-summary-v1'],
        ['admin.player.detail', 'admin-player-detail-v1'],
        ['admin.operation-policies.read', 'admin-operation-policies-v1'],
        ['admin.hooks.list', 'admin-hooks-v2'],
        ['admin.hooks.schema', 'admin-hooks-v2'],
        ['admin.hooks.assignments', 'admin-hooks-v2'],
        ['admin.hooks.detail', 'admin-hooks-v2'],
        ['admin.command-center.inbox', 'admin-command-center-v1'],
        ['admin.command-center.history', 'admin-command-center-v1'],
        ['admin.canonical-team.read', 'canonical-admin-team-v1'],
        ['admin.canonical-team.change.create', 'canonical-admin-team-v1'],
        ['admin.canonical-team.change.read', 'canonical-admin-team-v1'],
        ['admin.canonical-team.change.apply', 'canonical-admin-team-v1'],
        ['admin.canonical-team.change.cancel', 'canonical-admin-team-v1'],
        ['admin.canonical-team.change.undo', 'canonical-admin-team-v1'],
        ['admin.items.list', 'admin-item-list-v1'],
        ['admin.items.detail', 'admin-item-v1'],
        ['admin.rewards.list', 'admin-reward-list-v1'],
        ['admin.rewards.grants', 'admin-reward-grant-list-v1'],
        ['admin.rewards.detail', 'admin-reward-v1'],
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
    assert.deepEqual(audit.evidence.filter((entry) => entry.descriptorId.includes('economy.item-templates')).map((entry) => [entry.descriptorId, entry.contractShapeId]), [
        ['site.routeAuthed.post.economy.item-templates', 'site-economy-item-templates-create-shape-v1'],
        ['site.routeAuthed.patch.economy.item-templates.key', 'site-economy-item-templates-update-shape-v1'],
        ['site.routeAuthed.post.economy.item-templates.key.archive', 'site-economy-item-templates-archive-shape-v1'],
        ['site.routeAuthed.post.economy.item-templates.key.grant', 'site-economy-item-templates-grant-shape-v1'],
    ]);
    assert.deepEqual(audit.evidence.filter((entry) => entry.descriptorId.includes('economy.redemptions')).map((entry) => [entry.descriptorId, entry.contractShapeId]), [
        ['site.routeAuthed.post.economy.redemptions', 'site-economy-redemptions-create-shape-v1'],
        ['site.routeAuthed.post.economy.redemptions.key.cancel', 'site-economy-redemptions-cancel-shape-v1'],
        ['site.routeAuthed.post.economy.redemptions.key.approve', 'site-economy-redemptions-resolve-shape-v1'],
        ['site.routeAuthed.post.economy.redemptions.key.reject', 'site-economy-redemptions-resolve-shape-v1'],
    ]);
    assert.deepEqual(audit.evidence.filter((entry) => entry.descriptorId.includes('economy.titles') || entry.descriptorId.includes('economy.initial-package')).map((entry) => [entry.descriptorId, entry.contractShapeId]), [
        ['site.routeAuthed.post.economy.titles.deactivate', 'site-economy-titles-deactivate-shape-v1'],
        ['site.routeAuthed.post.economy.titles.key.activate', 'site-economy-titles-activate-shape-v1'],
        ['site.routeAuthed.post.economy.initial-package', 'site-economy-initial-package-shape-v1'],
    ]);
    assert.deepEqual(audit.evidence.filter((entry) => /economy\.(purchases|sales|repairs|consumables)/.test(entry.descriptorId)).map((entry) => [entry.descriptorId, entry.contractShapeId]), [
        ['site.routeAuthed.post.economy.purchases.preview', 'site-economy-purchases-preview-shape-v1'],
        ['site.routeAuthed.post.economy.purchases.key.confirm', 'site-economy-purchases-confirm-shape-v1'],
        ['site.routeAuthed.post.economy.purchases.key.cancel', 'site-economy-purchases-cancel-shape-v1'],
        ['site.routeAuthed.post.economy.sales.preview', 'site-economy-sales-preview-shape-v1'],
        ['site.routeAuthed.post.economy.sales.key.confirm', 'site-economy-sales-confirm-shape-v1'],
        ['site.routeAuthed.post.economy.repairs.preview', 'site-economy-repairs-preview-shape-v1'],
        ['site.routeAuthed.post.economy.repairs.key.confirm', 'site-economy-repairs-confirm-shape-v1'],
        ['site.routeAuthed.post.economy.consumables.itemId.use', 'site-economy-consumables-use-shape-v1'],
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

test('F7 item template and redemption evidence rejects body, path, response and family drift', async () => {
    const descriptors = canonicalRuntimeDescriptors();
    const registry = auditPublicContracts(descriptors).registry;
    const captures = (await runCriticalHandlerBoundaryProbes()).captures;
    const read = (overrides = {}, evidence = undefined) => auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, evidence, {
        captures: captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })), registry,
    });
    const reason = (audit, id) => audit.unproven.find((entry) => entry.descriptorId === id)?.reason;
    assert.equal(reason(read({ 'economy-item-template-create': { request: { method: 'POST', url: '/economy/item-templates', body: { templateKey: 'x', itemName: 'X' } } } }), 'site.routeAuthed.post.economy.item-templates'), 'body_mode_or_schema_mismatch');
    assert.equal(reason(read({ 'economy-item-template-grant': { request: { method: 'POST', url: '/economy/item-templates/grant/example', body: { playerId: 'alpha', quantity: 1 } } } }), 'site.routeAuthed.post.economy.item-templates.key.grant'), 'path_schema_mismatch');
    assert.equal(reason(read({ 'economy-redemption-approve': { payload: { ok: true } } }), 'site.routeAuthed.post.economy.redemptions.key.approve'), 'real_response_schema_mismatch');
    const evidence = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor).map((entry) => entry.descriptorId === 'site.routeAuthed.post.economy.redemptions.key.cancel' ? { ...entry, familyId: 'wrong-redemption-family' } : entry);
    assert.equal(reason(read({}, evidence), 'site.routeAuthed.post.economy.redemptions.key.cancel'), 'family_or_contract_misclassified');
});

test('F7 title and initial-package evidence rejects body, path, response and family drift', async () => {
    const descriptors = canonicalRuntimeDescriptors();
    const registry = auditPublicContracts(descriptors).registry;
    const captures = (await runCriticalHandlerBoundaryProbes()).captures;
    const read = (overrides = {}, evidence = undefined) => auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, evidence, {
        captures: captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })), registry,
    });
    const reason = (audit, id) => audit.unproven.find((entry) => entry.descriptorId === id)?.reason;
    assert.equal(reason(read({ 'economy-initial-package': { request: { method: 'POST', url: '/economy/initial-package', body: {} } } }), 'site.routeAuthed.post.economy.initial-package'), 'body_mode_or_schema_mismatch');
    assert.equal(reason(read({ 'economy-title-activate': { request: { method: 'POST', url: '/economy/titles/activate/example', body: null } } }), 'site.routeAuthed.post.economy.titles.key.activate'), 'path_schema_mismatch');
    assert.equal(reason(read({ 'economy-title-deactivate': { payload: { ok: true } } }), 'site.routeAuthed.post.economy.titles.deactivate'), 'real_response_schema_mismatch');
    const evidence = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor).map((entry) => entry.descriptorId === 'site.routeAuthed.post.economy.initial-package' ? { ...entry, familyId: 'wrong-initial-package-family' } : entry);
    assert.equal(reason(read({}, evidence), 'site.routeAuthed.post.economy.initial-package'), 'family_or_contract_misclassified');
});

test('F7 economy operation evidence rejects body, path, response and family drift', async () => {
    const descriptors = canonicalRuntimeDescriptors();
    const registry = auditPublicContracts(descriptors).registry;
    const captures = (await runCriticalHandlerBoundaryProbes()).captures;
    const read = (overrides = {}, evidence = undefined) => auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, evidence, {
        captures: captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })), registry,
    });
    const reason = (audit, id) => audit.unproven.find((entry) => entry.descriptorId === id)?.reason;
    assert.equal(reason(read({ 'economy-purchase-preview-confirm': { request: { method: 'POST', url: '/economy/purchases/preview', body: { listingKey: 'kit_campo' } } } }), 'site.routeAuthed.post.economy.purchases.preview'), 'body_mode_or_schema_mismatch');
    assert.equal(reason(read({ 'economy-sale-confirm': { request: { method: 'POST', url: '/economy/sales/confirm/example', body: null } } }), 'site.routeAuthed.post.economy.sales.key.confirm'), 'path_schema_mismatch');
    assert.equal(reason(read({ 'economy-repair-confirm': { payload: { ok: true, repair: {} } } }), 'site.routeAuthed.post.economy.repairs.key.confirm'), 'real_response_schema_mismatch');
    const evidence = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor).map((entry) => entry.descriptorId === 'site.routeAuthed.post.economy.consumables.itemId.use' ? { ...entry, familyId: 'wrong-consumable-family' } : entry);
    assert.equal(reason(read({}, evidence), 'site.routeAuthed.post.economy.consumables.itemId.use'), 'family_or_contract_misclassified');
});

test('F7 admin read evidence rejects body, path, response, family and method drift', async () => {
    const descriptors = canonicalRuntimeDescriptors();
    const registry = auditPublicContracts(descriptors).registry;
    const captures = (await runCriticalHandlerBoundaryProbes()).captures;
    const read = (overrides = {}, evidence = undefined) => auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, evidence, {
        captures: captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })), registry,
    });
    const reason = (audit, id) => audit.unproven.find((entry) => entry.descriptorId === id)?.reason;
    assert.equal(reason(read({ 'admin-player-search': { request: { method: 'GET', url: '/admin/players/search?q=alpha', body: {} } } }), 'admin.players.search'), 'body_mode_or_schema_mismatch');
    assert.equal(reason(read({ 'admin-player-detail': { request: { method: 'GET', url: '/admin/player/fixture-alpha%40lid', body: null } } }), 'admin.player.detail'), 'path_schema_mismatch');
    assert.equal(reason(read({ 'admin-integrity-summary': { payload: { ok: true } } }), 'admin.integrity.summary'), 'real_response_schema_mismatch');
    assert.equal(reason(read({ 'admin-player-search': { request: { method: 'POST', url: '/admin/players/search?q=alpha', body: null } } }), 'admin.players.search'), 'path_schema_mismatch');
    const evidence = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor).map((entry) => entry.descriptorId === 'admin.player.detail' ? { ...entry, familyId: 'wrong-admin-detail-family' } : entry);
    assert.equal(reason(read({}, evidence), 'admin.player.detail'), 'family_or_contract_misclassified');
});

test('F7 admin catalog evidence rejects body, path, response, family and method drift', async () => {
    const descriptors = canonicalRuntimeDescriptors();
    const registry = auditPublicContracts(descriptors).registry;
    const captures = (await runCriticalHandlerBoundaryProbes()).captures;
    const read = (overrides = {}, evidence = undefined) => auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, evidence, {
        captures: captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })), registry,
    });
    const reason = (audit, id) => audit.unproven.find((entry) => entry.descriptorId === id)?.reason;
    assert.equal(reason(read({ 'admin-items-list': { request: { method: 'GET', url: '/admin/items', body: {} } } }), 'admin.items.list'), 'body_mode_or_schema_mismatch');
    assert.equal(reason(read({ 'admin-item-detail': { request: { method: 'GET', url: '/admin/item/custom_f7_admin_read_item', body: null } } }), 'admin.items.detail'), 'path_schema_mismatch');
    assert.equal(reason(read({ 'admin-rewards-list': { payload: { ok: true, packages: [] } } }), 'admin.rewards.list'), 'real_response_schema_mismatch');
    assert.equal(reason(read({ 'admin-reward-grants-list': { request: { method: 'POST', url: '/admin/rewards/grants', body: null } } }), 'admin.rewards.grants'), 'path_schema_mismatch');
    const evidence = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor).map((entry) => entry.descriptorId === 'admin.rewards.detail' ? { ...entry, familyId: 'wrong-admin-reward-family' } : entry);
    assert.equal(reason(read({}, evidence), 'admin.rewards.detail'), 'family_or_contract_misclassified');
});

test('F7 admin hook evidence rejects body, path, response, family and method drift', async () => {
    const descriptors = canonicalRuntimeDescriptors();
    const registry = auditPublicContracts(descriptors).registry;
    const captures = (await runCriticalHandlerBoundaryProbes()).captures;
    const read = (overrides = {}, evidence = undefined) => auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, evidence, {
        captures: captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })), registry,
    });
    const reason = (audit, id) => audit.unproven.find((entry) => entry.descriptorId === id)?.reason;
    assert.equal(reason(read({ 'admin-hooks-list': { request: { method: 'GET', url: '/admin/hooks', body: {} } } }), 'admin.hooks.list'), 'body_mode_or_schema_mismatch');
    assert.equal(reason(read({ 'admin-hook-detail': { request: { method: 'GET', url: '/admin/hook/HK-EXAMPLE', body: null } } }), 'admin.hooks.detail'), 'path_schema_mismatch');
    assert.equal(reason(read({ 'admin-hooks-schema': { payload: { ok: true, version: 2 } } }), 'admin.hooks.schema'), 'real_response_schema_mismatch');
    assert.equal(reason(read({ 'admin-hook-assignments-list': { request: { method: 'POST', url: '/admin/hooks/assignments', body: null } } }), 'admin.hooks.assignments'), 'path_schema_mismatch');
    const evidence = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor).map((entry) => entry.descriptorId === 'admin.hooks.schema' ? { ...entry, familyId: 'wrong-admin-hooks-schema-family' } : entry);
    assert.equal(reason(read({}, evidence), 'admin.hooks.schema'), 'family_or_contract_misclassified');
});

test('F7 admin command-center evidence rejects body, path, response, family and method drift', async () => {
    const descriptors = canonicalRuntimeDescriptors();
    const registry = auditPublicContracts(descriptors).registry;
    const captures = (await runCriticalHandlerBoundaryProbes()).captures;
    const read = (overrides = {}, evidence = undefined) => auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, evidence, {
        captures: captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })), registry,
    });
    const reason = (audit, id) => audit.unproven.find((entry) => entry.descriptorId === id)?.reason;
    assert.equal(reason(read({ 'admin-command-center-inbox': { request: { method: 'GET', url: '/admin/inbox?limit=2', body: {} } } }), 'admin.command-center.inbox'), 'body_mode_or_schema_mismatch');
    assert.equal(reason(read({ 'admin-command-center-history': { request: { method: 'GET', url: '/admin/histories?limit=2', body: null } } }), 'admin.command-center.history'), 'path_schema_mismatch');
    assert.equal(reason(read({ 'admin-command-center-inbox': { payload: { ok: true, readOnly: true } } }), 'admin.command-center.inbox'), 'real_response_schema_mismatch');
    assert.equal(reason(read({ 'admin-command-center-history': { request: { method: 'POST', url: '/admin/history?limit=2', body: null } } }), 'admin.command-center.history'), 'path_schema_mismatch');
    const evidence = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor).map((entry) => entry.descriptorId === 'admin.command-center.history' ? { ...entry, familyId: 'wrong-admin-command-center-history-family' } : entry);
    assert.equal(reason(read({}, evidence), 'admin.command-center.history'), 'family_or_contract_misclassified');
});

test('F7 canonical admin-team evidence rejects body, path, response, family and method drift', async () => {
    const descriptors = canonicalRuntimeDescriptors();
    const registry = auditPublicContracts(descriptors).registry;
    const captures = (await runCriticalHandlerBoundaryProbes()).captures;
    const read = (overrides = {}, evidence = undefined) => auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, evidence, {
        captures: captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })), registry,
    });
    const reason = (audit, id) => audit.unproven.find((entry) => entry.descriptorId === id)?.reason;
    assert.equal(reason(read({ 'canonical-admin-team-read': { request: { method: 'GET', url: '/admin/team?changes=2', body: {} } } }), 'admin.canonical-team.read'), 'body_mode_or_schema_mismatch');
    assert.equal(reason(read({ 'canonical-admin-team-change-read': { request: { method: 'GET', url: '/admin/team/changes/AC-XYZ', body: null } } }), 'admin.canonical-team.change.read'), 'path_schema_mismatch');
    assert.equal(reason(read({ 'canonical-admin-team-change-apply': { payload: { ok: true, change: {} } } }), 'admin.canonical-team.change.apply'), 'real_response_schema_mismatch');
    assert.equal(reason(read({ 'canonical-admin-team-change-cancel': { request: { method: 'GET', url: '/admin/team/changes/AC-01020304/cancel', body: null } } }), 'admin.canonical-team.change.cancel'), 'path_schema_mismatch');
    const evidence = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor).map((entry) => entry.descriptorId === 'admin.canonical-team.change.undo' ? { ...entry, familyId: 'wrong-canonical-admin-team-undo-family' } : entry);
    assert.equal(reason(read({}, evidence), 'admin.canonical-team.change.undo'), 'family_or_contract_misclassified');
});
