'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const {
    handleRaidCoreIdempotentHttp,
    parseCoreRoute,
    requestIdempotencyKey,
} = require('../helpers/clover/raidCoreIdempotentHttp');

function makeReq(method, url, body = null, headers = {}) {
    const req = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = url;
    req.headers = headers;
    return req;
}

function makeRes() {
    return {
        statusCode: 0,
        headers: {},
        body: '',
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
        end(value = '') { this.body += value || ''; },
    };
}

function options(overrides = {}) {
    return {
        getDb: () => ({ fake: true }),
        authenticateSession: async () => ({ ok: true, player: { id: 'actor@test' } }),
        mutationRunner: async (operation) => operation(),
        ...overrides,
    };
}

test('core parser recognizes create, condition-add and reward-add only', () => {
    assert.deepEqual(parseCoreRoute('/raids'), { kind: 'create' });
    assert.deepEqual(parseCoreRoute('/raids/RAID-X/conditions'), {
        kind: 'condition-add',
        raidKey: 'RAID-X',
    });
    assert.deepEqual(parseCoreRoute('/raids/RAID-X/rewards'), {
        kind: 'reward-add',
        raidKey: 'RAID-X',
    });
    assert.equal(parseCoreRoute('/raids/RAID-X/rewards/1/cancel'), null);
});

test('header idempotency key overrides body key', () => {
    assert.equal(
        requestIdempotencyKey(
            { headers: { 'idempotency-key': 'header-key' } },
            { idempotencyKey: 'body-key' }
        ),
        'header-key'
    );
});

test('create raid forwards stable key and returns 201 on first execution', async () => {
    let captured = null;
    const req = makeReq(
        'POST',
        '/raids',
        { name: 'Raid Teste', idempotencyKey: 'body-key' },
        { authorization: 'Bearer token', 'idempotency-key': 'create-key' }
    );
    const res = makeRes();

    await handleRaidCoreIdempotentHttp(req, res, options({
        createRaid: async (...args) => {
            captured = args;
            return { ok: true, duplicate: false, raid: { key: 'RAID-X' } };
        },
    }));

    assert.equal(res.statusCode, 201);
    assert.equal(captured[1], 'actor@test');
    assert.equal(captured[2].name, 'Raid Teste');
    assert.equal(captured[2].idempotencyKey, 'create-key');
});

test('create raid returns 200 for idempotent replay', async () => {
    const res = makeRes();
    await handleRaidCoreIdempotentHttp(
        makeReq('POST', '/raids', { name: 'Raid Teste', idempotencyKey: 'create-key' }, { authorization: 'Bearer token' }),
        res,
        options({
            createRaid: async () => ({ ok: true, duplicate: true, raid: { key: 'RAID-X' } }),
        })
    );
    assert.equal(res.statusCode, 200);
});

test('condition and reward add routes forward body plus idempotency key', async () => {
    const calls = [];
    const common = options({
        addRaidCondition: async (...args) => {
            calls.push(['condition', args]);
            return { ok: true, duplicate: false };
        },
        addRaidReward: async (...args) => {
            calls.push(['reward', args]);
            return { ok: true, duplicate: false };
        },
    });

    const conditionRes = makeRes();
    await handleRaidCoreIdempotentHttp(
        makeReq(
            'POST',
            '/raids/RAID-X/conditions',
            { label: 'Ferido' },
            { authorization: 'Bearer token', 'idempotency-key': 'condition-key' }
        ),
        conditionRes,
        common
    );

    const rewardRes = makeRes();
    await handleRaidCoreIdempotentHttp(
        makeReq(
            'POST',
            '/raids/RAID-X/rewards',
            { rewardType: 'ph', amount: 5 },
            { authorization: 'Bearer token', 'idempotency-key': 'reward-key' }
        ),
        rewardRes,
        common
    );

    assert.equal(conditionRes.statusCode, 201);
    assert.equal(rewardRes.statusCode, 201);
    assert.equal(calls[0][1][1], 'RAID-X');
    assert.equal(calls[0][1][3].idempotencyKey, 'condition-key');
    assert.equal(calls[1][1][1], 'RAID-X');
    assert.equal(calls[1][1][3].idempotencyKey, 'reward-key');
});
