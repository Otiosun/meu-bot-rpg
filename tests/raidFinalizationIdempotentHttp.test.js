'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const {
    handleRaidFinalizationIdempotentHttp,
} = require('../helpers/clover/raidFinalizationIdempotentHttp');

function request(body, headers = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
    req.method = 'POST';
    req.url = '/raids/RAID-X/finalization/participants/target%40test';
    req.headers = { authorization: 'Bearer token', ...headers };
    return req;
}

function response() {
    return {
        statusCode: 0,
        headers: {},
        body: '',
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
        end(value = '') { this.body += value || ''; },
    };
}

test('finalization review forwards actor, target and stable idempotency key', async () => {
    let captured = null;
    const res = response();
    const handled = await handleRaidFinalizationIdempotentHttp(
        request(
            { status: 'eligible', note: 'presente' },
            { 'idempotency-key': 'finalization-key-1' }
        ),
        res,
        {
            getDb: () => ({ fake: true }),
            authenticateSession: async () => ({ ok: true, player: { id: 'actor@test' } }),
            mutationRunner: async (operation) => operation(),
            setRaidParticipantFinalization: async (...args) => {
                captured = args;
                return { ok: true, participant: { finalizationStatus: 'eligible' } };
            },
        }
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(captured[1], 'RAID-X');
    assert.equal(captured[2], 'actor@test');
    assert.equal(captured[3], 'target@test');
    assert.equal(captured[4].status, 'eligible');
    assert.equal(captured[4].idempotencyKey, 'finalization-key-1');
});
