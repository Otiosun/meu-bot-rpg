'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getAdminOperationExecutors } = require('../helpers/clover/adminOperationRegistry');
const { isRecognizedAdminPath, ADMIN_DELEGATED_ROUTE_DESCRIPTORS } = require('../helpers/clover/adminApiSupport');
const { parseAdminMarketPath } = require('../helpers/clover/adminMarketHttp');
const { getRoleCapabilities } = require('../helpers/clover/adminOperationContract');

test('Market moderation action is registered with preview/apply', () => {
    const executor = getAdminOperationExecutors()['market.listing.cancel'];
    assert.equal(typeof executor?.preview, 'function');
    assert.equal(typeof executor?.apply, 'function');
});

test('Market admin routes are recognized by the canonical dispatcher', () => {
    for (const path of ['/admin/market', '/admin/market/ANU-TEST']) {
        assert.ok(parseAdminMarketPath(path), path);
        assert.equal(isRecognizedAdminPath(new URL(path, 'http://localhost')), true, path);
    }
    const ids = new Set(ADMIN_DELEGATED_ROUTE_DESCRIPTORS.map((route) => route.id));
    assert.equal(ids.has('admin.market.list'), true);
    assert.equal(ids.has('admin.market.detail'), true);
});

test('admin role receives Market view/manage capabilities', () => {
    const capabilities = getRoleCapabilities('admin');
    assert.equal(capabilities.includes('market.view'), true);
    assert.equal(capabilities.includes('market.manage'), true);
});
