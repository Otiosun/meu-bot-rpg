'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ADMIN_DELEGATED_ROUTE_DESCRIPTORS,
    isRecognizedAdminPath,
} = require('../helpers/clover/adminApiSupport');
const {
    handleAdminRewardsReadApi,
    isAdminRewardsPath,
} = require('../helpers/clover/adminRewardsReadApi');

function responseCapture() {
    return {
        statusCode: 0,
        headers: {},
        body: '',
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
        end(value = '') { this.body += String(value); },
    };
}

test('Rewards V2 routes are recognized by the canonical admin dispatcher', () => {
    for (const path of [
        '/admin/rewards',
        '/admin/rewards/RW-TEST',
        '/admin/rewards/grants',
    ]) {
        assert.equal(isAdminRewardsPath(path), true, path);
        assert.equal(isRecognizedAdminPath(new URL(path, 'http://localhost')), true, path);
    }
    const ids = new Set(ADMIN_DELEGATED_ROUTE_DESCRIPTORS.map((route) => route.id));
    for (const id of ['admin.rewards.list', 'admin.rewards.detail', 'admin.rewards.grants']) {
        assert.equal(ids.has(id), true, id);
    }
});

test('Rewards V2 list exposes the V2 entry types and PH policies', async () => {
    const req = {
        method: 'GET',
        url: '/admin/rewards',
        headers: { authorization: 'Bearer test' },
    };
    const res = responseCapture();
    const handled = await handleAdminRewardsReadApi(req, res, {
        getDb: () => ({}),
        authenticateSession: async () => ({ ok: true, player: { id: 'admin@test' } }),
        accessResolver: async () => ({
            ok: true,
            actor: { id: 'admin@test', capabilities: ['catalog.view'] },
        }),
        listPackages: async () => ({
            ok: true,
            packages: [],
            statuses: ['active', 'archived'],
            supportedEntryTypes: ['legacy'],
        }),
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.deepEqual(payload.supportedEntryTypes, ['yulls', 'ph', 'pa', 'pm', 'item', 'box', 'title', 'trait', 'hook']);
    assert.deepEqual(payload.phCapPolicies, ['outside_weekly', 'weekly', 'adjustment']);
});
