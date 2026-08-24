'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { RECRUITMENT_SHOP_ROUTE_DESCRIPTORS } = require('../helpers/clover/siteApiServerLegacy');
const { matchDescriptor } = require('../helpers/clover/httpRouteDescriptor');

test('recruitment shop descriptors distinguish catalog from idempotent purchase', () => {
    assert.equal(matchDescriptor(RECRUITMENT_SHOP_ROUTE_DESCRIPTORS, 'GET', '/recruitment/shop')?.id, 'recruitment.shop.read');
    assert.equal(matchDescriptor(RECRUITMENT_SHOP_ROUTE_DESCRIPTORS, 'POST', '/recruitment/shop'), null);
    assert.equal(matchDescriptor(RECRUITMENT_SHOP_ROUTE_DESCRIPTORS, 'POST', '/recruitment/shop/example-item/purchase')?.id, 'recruitment.shop.purchase');
    assert.equal(matchDescriptor(RECRUITMENT_SHOP_ROUTE_DESCRIPTORS, 'GET', '/recruitment/shop/example-item/purchase'), null);
});
