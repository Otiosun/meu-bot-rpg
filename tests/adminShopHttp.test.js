'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    handleAdminShopHttp,
    parseAdminShopPath,
} = require('../helpers/clover/adminShopHttp');

function harness() {
    let body = '';
    return {
        res: {
            statusCode: 200,
            setHeader() {},
            end(value = '') { body = String(value); },
        },
        read() {
            return {
                status: this.res.statusCode,
                body: body ? JSON.parse(body) : null,
            };
        },
    };
}

function context(capabilities = ['catalog.view']) {
    return {
        db: {},
        access: { actor: { id: 'admin-1', capabilities } },
    };
}

test('shop admin parser exposes only the dashboard route', () => {
    assert.deepEqual(parseAdminShopPath('/admin/shops'), { kind: 'dashboard' });
    assert.equal(parseAdminShopPath('/admin/shops/extra'), null);
});

test('shop admin dashboard is capability protected', async () => {
    const ok = harness();
    await handleAdminShopHttp(
        { method: 'GET', url: '/admin/shops', headers: {} },
        ok.res,
        {
            resolveAdminContext: async () => context(),
            adminShopDashboard: async () => ({
                ok: true,
                activeVersion: 2,
                pendingPurchaseCount: 0,
                versions: [],
            }),
        }
    );
    assert.equal(ok.read().status, 200);
    assert.equal(ok.read().body.activeVersion, 2);

    const blocked = harness();
    await handleAdminShopHttp(
        { method: 'GET', url: '/admin/shops', headers: {} },
        blocked.res,
        {
            resolveAdminContext: async () => context([]),
            adminShopDashboard: async () => ({ ok: true }),
        }
    );
    assert.equal(blocked.read().status, 403);
    assert.equal(blocked.read().body.error, 'missing_capability');
});
