'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runCriticalHandlerBoundaryProbes } = require('../helpers/clover/siteApiHandlerBoundaryProbes');

test('F7 calls real route owners for every critical boundary family', async () => {
    const result = await runCriticalHandlerBoundaryProbes();
    assert.equal(result.probed, result.total);
    assert.deepEqual(result.failures, []);
    assert.ok(result.probes.every((probe) => /^MATCHED_/.test(probe.outcome)));
    assert.ok(result.captures.some((probe) => probe.name === 'base-public' && probe.payload?.ok === true));
    assert.deepEqual(result.captures.filter((probe) => probe.name.startsWith('raid')).map((probe) => [probe.name, probe.descriptorId, probe.contractId, probe.semanticFamily]), [
        ['raid-create', 'raid.create', 'raid-create-v1', 'raid-core-create-v1'],
        ['raid-condition', 'raid.condition.add', 'raid-condition-add-v1', 'raid-core-condition-add-v1'],
        ['raid-reward', 'raid.reward.add', 'raid-reward-add-v1', 'raid-core-reward-add-v1'],
        ['raid-host-add', 'raid.host.add', 'raid-host-v1', 'raid-host-add-v1'],
        ['raid-host-revoke', 'raid.host.revoke', 'raid-host-v1', 'raid-host-revoke-v1'],
    ]);
    assert.equal(result.captures.find((probe) => probe.name === 'raid-create').payload?.raid?.key, 'probe-raid');
    assert.equal(result.captures.find((probe) => probe.name === 'raid-condition').payload?.condition?.id, 1);
    assert.equal(result.captures.find((probe) => probe.name === 'raid-reward').payload?.reward?.id, 1);
    assert.equal(result.captures.find((probe) => probe.name === 'raid-host-add').payload?.host?.player_id, 'probe-cohost');
    assert.deepEqual(result.captures.find((probe) => probe.name === 'raid-host-revoke').payload, { ok: true });
    assert.equal(result.captures.find((probe) => probe.name === 'admin-bootstrap').payload?.actor?.id, 'probe-admin');
    assert.deepEqual(result.captures.find((probe) => probe.name === 'admin-policy-catalog').payload?.policies, ['atomic', 'per_target']);
    const preReset = result.captures.filter((probe) => probe.name.startsWith('prereset-'));
    assert.deepEqual(preReset.map((probe) => [probe.name, probe.descriptorId, probe.contractShapeId, probe.status]), [
        ['prereset-future-character-read', 'prereset.future-character.read', 'future-character-read-shape-v1', 200],
        ['prereset-future-character-post', 'prereset.future-character.write', 'future-character-write-shape-v1', 200],
        ['prereset-future-character-put', 'prereset.future-character.write', 'future-character-write-shape-v1', 200],
        ['prereset-future-character-submit', 'prereset.future-character.submit', 'future-character-submit-shape-v1', 200],
        ['prereset-return-points-balance', 'prereset.return-points.balance', 'return-points-balance-v1', 200],
        ['prereset-conversion-read', 'prereset.conversion.read', 'conversion-read-shape-v1', 200],
        ['prereset-conversion-claim', 'prereset.conversion.claim', 'conversion-claim-shape-v1', 200],
        ['prereset-shop-catalog', 'prereset.shop.catalog', 'reset-shop-catalog-v1', 200],
        ['prereset-shop-purchase', 'prereset.shop.purchase', 'reset-shop-purchase-v1', 200],
        ['prereset-admin-review', 'prereset.admin.review', 'future-character-review-shape-v1', 200],
    ]);
    assert.deepEqual(preReset.find((probe) => probe.name === 'prereset-shop-purchase').payload && Object.keys(preReset.find((probe) => probe.name === 'prereset-shop-purchase').payload).sort(), ['balanceAfter', 'duplicate', 'entitlement', 'ok', 'purchase']);
    const payments = result.captures.filter((probe) => probe.name.startsWith('economy-payment'));
    assert.deepEqual(payments.map((probe) => [probe.name, probe.descriptorId, probe.contractShapeId, probe.status, probe.payload?.payment?.status]), [
        ['economy-payment-preview', 'site.routeAuthed.post.economy.payments.preview', 'site-economy-payments-preview-shape-v1', 201, 'pending'],
        ['economy-payment-confirm', 'site.routeAuthed.post.economy.payments.key.confirm', 'site-economy-payments-confirm-shape-v1', 200, 'completed'],
        ['economy-payment-cancel-preview', 'site.routeAuthed.post.economy.payments.preview', 'site-economy-payments-preview-shape-v1', 201, 'pending'],
        ['economy-payment-cancel', 'site.routeAuthed.post.economy.payments.key.cancel', 'site-economy-payments-cancel-shape-v1', 200, 'cancelled'],
    ]);
    const market = result.captures.filter((probe) => probe.name.startsWith('economy-market'));
    assert.deepEqual(market.map((probe) => [probe.name, probe.descriptorId, probe.contractShapeId, probe.status]), [
        ['economy-market-listing-preview', 'site.routeAuthed.post.economy.market.listings.preview', 'site-economy-market-listings-preview-shape-v1', 200],
        ['economy-market-listing-create', 'site.routeAuthed.post.economy.market.listings', 'site-economy-market-listings-create-shape-v1', 201],
        ['economy-market-purchase-preview', 'site.routeAuthed.post.economy.market.purchases.preview', 'site-economy-market-purchases-preview-shape-v1', 201],
        ['economy-market-purchase-confirm', 'site.routeAuthed.post.economy.market.purchases.key.confirm', 'site-economy-market-purchases-confirm-shape-v1', 200],
        ['economy-market-listing-cancel', 'site.routeAuthed.post.economy.market.listings.key.cancel', 'site-economy-market-listings-cancel-shape-v1', 200],
        ['economy-market-purchase-cancel-preview', 'site.routeAuthed.post.economy.market.purchases.preview', 'site-economy-market-purchases-preview-shape-v1', 201],
        ['economy-market-purchase-cancel', 'site.routeAuthed.post.economy.market.purchases.key.cancel', 'site-economy-market-purchases-cancel-shape-v1', 200],
        ['economy-market-auction-bid', 'site.routeAuthed.post.economy.market.auctions.key.bids', 'site-economy-market-auctions-bid-shape-v1', 201],
    ]);
    assert.equal(market.find((probe) => probe.name === 'economy-market-listing-create').payload?.listing?.status, 'active');
    assert.equal(market.find((probe) => probe.name === 'economy-market-purchase-confirm').payload?.intent?.status, 'completed');
    assert.equal(market.find((probe) => probe.name === 'economy-market-listing-cancel').payload?.listing?.status, 'cancelled');
    assert.equal(market.find((probe) => probe.name === 'economy-market-purchase-cancel').payload?.intent?.status, 'cancelled');
    assert.equal(market.find((probe) => probe.name === 'economy-market-auction-bid').payload?.bid?.status, 'current');
});

test('F7 runtime boundary probe fails if a family target is disabled', async () => {
    const full = await runCriticalHandlerBoundaryProbes();
    const result = await runCriticalHandlerBoundaryProbes({ disableFamily: 'raid' });
    const expectedRemoved = full.probes.filter((probe) => probe.name.startsWith('raid')).length;
    assert.equal(expectedRemoved, 5);
    assert.equal(result.probed, full.probed - expectedRemoved);
    assert.equal(result.total, full.total);
    assert.equal(result.probes.filter((probe) => probe.name.startsWith('raid')).length, 0);
});
