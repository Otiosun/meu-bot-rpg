'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleAdminApiSupport } = require('../helpers/clover/adminApiSupport');

function responseRecorder() {
    return {
        statusCode: 200,
        headers: {},
        body: '',
        setHeader(name, value) {
            this.headers[String(name).toLowerCase()] = value;
        },
        end(value = '') {
            this.body += String(value || '');
        },
    };
}

function request(url) {
    return {
        method: 'GET',
        url,
        headers: { authorization: 'Bearer test' },
    };
}

function authorizedOptions(overrides = {}) {
    return {
        getDb: () => ({ fake: true }),
        authenticateSession: async () => ({
            ok: true,
            player: { id: 'owner@lid', personagem_nome: 'Owner' },
        }),
        accessResolver: async () => ({
            ok: true,
            actor: {
                id: 'owner@lid',
                role: 'owner',
                capabilities: ['catalog.view'],
            },
        }),
        ...overrides,
    };
}

async function call(url, options) {
    const res = responseRecorder();
    const handled = await handleAdminApiSupport(request(url), res, options);
    return { handled, res, payload: res.body ? JSON.parse(res.body) : null };
}

test('roteador administrativo principal entrega catálogo de Ganchos', async () => {
    let received = null;
    const result = await call('/admin/hooks?q=carta', authorizedOptions({
        listHooks: async (_db, options) => {
            received = options;
            return { ok: true, hooks: [{ id: 'HK-00000001', name: 'Carta Selada' }] };
        },
    }));

    assert.equal(result.handled, true);
    assert.equal(result.res.statusCode, 200);
    assert.equal(result.payload.hooks[0].name, 'Carta Selada');
    assert.equal(received.query, 'carta');
});

test('roteador administrativo principal entrega acompanhamento de Ganchos', async () => {
    let received = null;
    const result = await call('/admin/hooks/assignments?playerId=emil%40lid', authorizedOptions({
        listAssignments: async (_db, options) => {
            received = options;
            return { ok: true, assignments: [] };
        },
    }));

    assert.equal(result.handled, true);
    assert.equal(result.res.statusCode, 200);
    assert.deepEqual(result.payload.assignments, []);
    assert.equal(received.playerId, 'emil@lid');
});

test('roteador administrativo principal entrega Recompensas e Itens', async () => {
    const rewards = await call('/admin/rewards', authorizedOptions({
        listPackages: async () => ({ ok: true, packages: [] }),
    }));
    assert.equal(rewards.handled, true);
    assert.equal(rewards.res.statusCode, 200);
    assert.deepEqual(rewards.payload.packages, []);

    const items = await call('/admin/items', authorizedOptions({
        listItems: async () => [],
    }));
    assert.equal(items.handled, true);
    assert.equal(items.res.statusCode, 200);
    assert.deepEqual(items.payload.items, []);
});
