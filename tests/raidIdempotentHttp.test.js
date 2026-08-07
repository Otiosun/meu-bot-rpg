'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const {
    handleRaidIdempotentHttp,
    parseRoute,
    requestIdempotencyKey,
} = require('../helpers/clover/raidIdempotentHttp');

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
        setHeader(name, value) {
            this.headers[String(name).toLowerCase()] = value;
        },
        end(value = '') {
            this.body += value || '';
        },
    };
}

function baseOptions(overrides = {}) {
    return {
        getDb: () => ({ fake: true }),
        authenticateSession: async () => ({ ok: true, player: { id: 'actor@test' } }),
        mutationRunner: async (operation) => operation(),
        ...overrides,
    };
}

test('raid idempotent HTTP recognizes only co-host and loadout mutation routes', () => {
    assert.deepEqual(parseRoute('/raids/RAID-X/hosts'), {
        kind: 'host',
        raidKey: 'RAID-X',
    });
    assert.deepEqual(parseRoute('/raids/RAID-X/loadout/main_hand'), {
        kind: 'loadout',
        raidKey: 'RAID-X',
        slot: 'main_hand',
    });
    assert.equal(parseRoute('/raids/RAID-X/rewards'), null);
});

test('co-host route forwards Idempotency-Key header without requiring it from legacy clients', async () => {
    let captured = null;
    const req = makeReq(
        'POST',
        '/raids/RAID-X/hosts',
        { playerId: 'target@test' },
        { authorization: 'Bearer token', 'idempotency-key': 'host-key-1' }
    );
    const res = makeRes();

    const handled = await handleRaidIdempotentHttp(req, res, baseOptions({
        addRaidHost: async (...args) => {
            captured = args;
            return { ok: true, host: { player_id: 'target@test' } };
        },
    }));

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(captured[1], 'RAID-X');
    assert.equal(captured[2], 'actor@test');
    assert.equal(captured[3], 'target@test');
    assert.equal(captured[4].idempotencyKey, 'host-key-1');
});

test('loadout route forwards body idempotency key and canonical actor', async () => {
    let captured = null;
    const req = makeReq(
        'PUT',
        '/raids/RAID-X/loadout/main_hand',
        { inventoryItemId: 99, quantity: 1, idempotencyKey: 'loadout-key-1' },
        { authorization: 'Bearer token' }
    );
    const res = makeRes();

    const handled = await handleRaidIdempotentHttp(req, res, baseOptions({
        setRaidLoadoutSlot: async (...args) => {
            captured = args;
            return { ok: true, slot: 'main_hand' };
        },
    }));

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(captured[1], 'RAID-X');
    assert.equal(captured[2], 'actor@test');
    assert.equal(captured[3], 'main_hand');
    assert.equal(captured[4].inventoryItemId, 99);
    assert.equal(captured[4].idempotencyKey, 'loadout-key-1');
});

test('header idempotency key takes precedence over body key', () => {
    const req = {
        headers: { 'idempotency-key': 'header-key' },
    };
    assert.equal(
        requestIdempotencyKey(req, { idempotencyKey: 'body-key' }),
        'header-key'
    );
});
