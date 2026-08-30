'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPreResetPolicyRegistry } = require('../helpers/clover/preResetPolicyRegistryService');

function shopPolicy() {
    return {
        status: 'ENABLED',
        policyVersion: 'shop-provenance-v1',
        catalogVersion: 'shop-provenance-catalog-v1',
        products: [
            { itemKey: 'fixture-item', entitlementKey: 'fixture:entitlement', priceReturnPoints: 5 },
        ],
    };
}

test('proveniencia TEST-ONLY da loja existe internamente sem alterar o contrato publico do produto', () => {
    const registry = createPreResetPolicyRegistry({
        testOnly: true,
        policies: { RESET_SHOP: shopPolicy() },
    });
    const product = registry.get('RESET_SHOP').products[0];

    assert.equal(product.testOnly, true);
    assert.equal(Object.prototype.propertyIsEnumerable.call(product, 'testOnly'), false);
    assert.equal(Object.keys(product).includes('testOnly'), false);
    assert.equal(JSON.stringify(product).includes('testOnly'), false);
    assert.deepEqual(product, {
        itemKey: 'fixture-item',
        entitlementKey: 'fixture:entitlement',
        priceReturnPoints: 5,
    });
});

test('policy de producao aprovada nunca recebe bypass TEST-ONLY', () => {
    const registry = createPreResetPolicyRegistry({
        productionApproval: {
            approvedBy: 'owner',
            approvalId: 'return-shop-owner-approval-v1',
            approvedAt: '2026-08-29T23:59:00.000Z',
        },
        policies: { RESET_SHOP: shopPolicy() },
    });
    const product = registry.get('RESET_SHOP').products[0];

    assert.equal(product.testOnly, false);
    assert.equal(Object.prototype.propertyIsEnumerable.call(product, 'testOnly'), false);
    assert.equal(JSON.stringify(product).includes('testOnly'), false);
});