'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { matchDescriptor } = require('../helpers/clover/httpRouteDescriptor');
const { SITE_API_BASE_ROUTE_DESCRIPTORS } = require('../helpers/clover/siteApiBaseRouteDescriptors');
test('base route seed has concrete exact-method descriptors', () => {
    assert.equal(SITE_API_BASE_ROUTE_DESCRIPTORS.length, 105);
    assert.equal(SITE_API_BASE_ROUTE_DESCRIPTORS.filter((route) => route.template.includes(':')).length, 48);
    assert.ok(matchDescriptor(SITE_API_BASE_ROUTE_DESCRIPTORS, 'POST', '/economy/payments/key/confirm'));
    assert.equal(matchDescriptor(SITE_API_BASE_ROUTE_DESCRIPTORS, 'GET', '/economy/payments/key/confirm'), null);
    assert.ok(matchDescriptor(SITE_API_BASE_ROUTE_DESCRIPTORS, 'GET', '/hexagon'));
    assert.ok(matchDescriptor(SITE_API_BASE_ROUTE_DESCRIPTORS, 'POST', '/hexagon'));
    assert.equal(matchDescriptor(SITE_API_BASE_ROUTE_DESCRIPTORS, 'POST', '/raids')?.visibility, 'INTERNAL_COMPAT_SHADOWED');
});
