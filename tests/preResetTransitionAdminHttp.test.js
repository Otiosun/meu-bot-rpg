'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    handlePreResetTransitionAdminHttp,
} = require('../helpers/clover/preResetTransitionAdminHttp');

function responseRecorder() {
    return {
        statusCode: 0,
        headers: {},
        body: '',
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
        end(value = '') { this.body = String(value); },
    };
}

function request(method = 'GET', authorization = 'Bearer token-test') {
    return {
        method,
        url: '/pre-reset/admin/transition/dashboard',
        headers: { authorization, origin: 'https://example.test' },
    };
}

test('dashboard PRE_RESET exige sessão autenticada', async () => {
    const res = responseRecorder();
    const handled = await handlePreResetTransitionAdminHttp(request(), res, {
        getDb: () => ({}),
        authenticateSiteSession: async () => ({ ok: false, reason: 'invalid_token' }),
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, 'invalid_token');
});

test('dashboard PRE_RESET exige capability administrativa', async () => {
    const res = responseRecorder();
    const handled = await handlePreResetTransitionAdminHttp(request(), res, {
        getDb: () => ({}),
        authenticateSiteSession: async () => ({ ok: true, player: { id: 'admin@test' } }),
        getIntegratedAccessContext: async () => ({ owner: false, assignments: [] }),
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'capability_denied');
});

test('dashboard PRE_RESET expõe apenas contadores para staff autorizado', async () => {
    const expected = {
        legacyTotal: 12,
        decision: { pending: 4, keep: 3, reset: 2, autoReset: 3 },
        futureCharacter: { draft: 2, submitted: 1, approved: 1, locked: 3 },
    };
    const res = responseRecorder();
    const handled = await handlePreResetTransitionAdminHttp(request(), res, {
        getDb: () => ({}),
        authenticateSiteSession: async () => ({ ok: true, player: { id: 'owner@test' } }),
        getIntegratedAccessContext: async () => ({ owner: true, assignments: [] }),
        getPreResetAdminOverview: async () => expected,
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.dashboard, expected);
    assert.deepEqual(payload.painel, expected);
});

test('dashboard PRE_RESET rejeita mutação HTTP', async () => {
    const res = responseRecorder();
    const handled = await handlePreResetTransitionAdminHttp(request('POST'), res, {
        getDb: () => ({}),
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 405);
    assert.equal(JSON.parse(res.body).error, 'method_not_allowed');
});
