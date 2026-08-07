'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { RaidServiceError } = require('../helpers/clover/raidService');
const {
    handleRaidAtomicFinalizationHttp,
    statusForError,
} = require('../helpers/clover/raidAtomicFinalizationHttp');

function makeReq(method, url, headers = {}) {
    const req = Readable.from([]);
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

test('finalize route delegates to atomic service with authenticated actor', async () => {
    let captured = null;
    const req = makeReq('POST', '/raids/RAID-X/finalize', { authorization: 'Bearer token' });
    const res = makeRes();

    const handled = await handleRaidAtomicFinalizationHttp(req, res, {
        getDb: () => ({ fake: true }),
        authenticateSession: async () => ({ ok: true, player: { id: 'host@test' } }),
        mutationRunner: async (operation) => operation(),
        beginRaidFinalization: async (...args) => {
            captured = args;
            return { ok: true, duplicate: false };
        },
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(captured[1], 'RAID-X');
    assert.equal(captured[2], 'host@test');
});

test('atomic finalization state races map to HTTP 409', () => {
    for (const code of ['raid_not_in_progress', 'raid_state_changed']) {
        assert.equal(statusForError(new RaidServiceError(code, code)), 409, code);
    }
});
