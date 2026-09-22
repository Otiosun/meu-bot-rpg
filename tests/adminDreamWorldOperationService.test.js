'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    AdminDreamWorldOperationError,
    assertSameWorld,
    createAdminDreamWorldExecutors,
    normalizeAcquisitionPayload,
} = require('../helpers/clover/adminDreamWorldOperationService');

test('Dream World admin executors expose the safe OP lifecycle', () => {
    const executors = createAdminDreamWorldExecutors();
    const acquisition = executors['system.dream_world.acquisition.update'];
    const status = executors['system.dream_world.status.transition'];

    assert.equal(typeof acquisition?.preview, 'function');
    assert.equal(typeof acquisition?.apply, 'function');
    assert.equal(typeof acquisition?.undo, 'function');
    assert.equal(typeof status?.preview, 'function');
    assert.equal(typeof status?.apply, 'function');
    assert.equal(status?.undo, undefined);
});

test('Dream World acquisition OP preserves dual acquisition validation', () => {
    const value = normalizeAcquisitionPayload({
        yullsPrice: 1000000,
        manualPaymentEnabled: true,
        manualPriceLabel: 'R$ 80,00',
        reason: 'Rebalanceamento',
    });
    assert.equal(value.yullsPrice, 1000000);
    assert.equal(value.manualPaymentEnabled, true);
    assert.equal(value.manualPriceLabel, 'R$ 80,00');
    assert.equal(value.reason, 'Rebalanceamento');

    assert.throws(
        () => normalizeAcquisitionPayload({ yullsPrice: 0, manualPaymentEnabled: true, manualPriceLabel: 'R$ 80,00' }),
        (error) => error instanceof AdminDreamWorldOperationError
    );
});

test('Dream World stale comparison blocks apply after relevant state changes', () => {
    const before = {
        id: 1, key: 'MSW-1', slug: 'fenda', status: 'draft',
        price: { yulls: 1000, manualEnabled: true, manualLabel: 'R$ 10,00' },
        announcedAt: null, purchaseOpensAt: null, purchaseClosesAt: null,
    };
    assert.doesNotThrow(() => assertSameWorld({ ...before }, before, 'stale'));
    assert.throws(
        () => assertSameWorld({ ...before, status: 'announced' }, before, 'stale'),
        (error) => error instanceof AdminDreamWorldOperationError && error.code === 'stale'
    );
});
