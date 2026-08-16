'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { RaidRewardProposalError } = require('../helpers/clover/raidRewardProposalService');
const {
    handleRaidRewardProposalIdempotentHttp,
    statusForError,
} = require('../helpers/clover/raidRewardProposalIdempotentHttp');

function request(body, headers = {}, proposalId = '42') {
    const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
    req.method = 'POST';
    req.url = `/raid-reward-proposals/${proposalId}/review`;
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

function baseOptions(overrides = {}) {
    return {
        getDb: () => ({ fake: true }),
        authenticateSession: async () => ({ ok: true, player: { id: 'reviewer@test' } }),
        mutationRunner: async (operation) => operation(),
        ...overrides,
    };
}

test('proposal review forwards decision, note and Idempotency-Key', async () => {
    let captured = null;
    const res = response();
    const handled = await handleRaidRewardProposalIdempotentHttp(
        request(
            { decision: 'return', note: 'Ajustar recompensa' },
            { 'idempotency-key': 'proposal-review-key-1' }
        ),
        res,
        baseOptions({
            reviewRaidRewardProposal: async (_db, input) => {
                captured = input;
                return { ok: true, proposal: { id: '42', status: 'returned' } };
            },
        })
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(captured.proposalId, '42');
    assert.equal(captured.actorId, 'reviewer@test');
    assert.equal(captured.decision, 'return');
    assert.equal(captured.note, 'Ajustar recompensa');
    assert.equal(captured.idempotencyKey, 'proposal-review-key-1');
});

test('proposal review header key takes precedence over body key', async () => {
    let captured = null;
    const res = response();
    await handleRaidRewardProposalIdempotentHttp(
        request(
            { decision: 'approve', idempotencyKey: 'body-key' },
            { 'idempotency-key': 'header-key' }
        ),
        res,
        baseOptions({
            reviewRaidRewardProposal: async (_db, input) => {
                captured = input;
                return { ok: true };
            },
        })
    );

    assert.equal(res.statusCode, 200);
    assert.equal(captured.idempotencyKey, 'header-key');
});

test('proposal review keeps legacy clients compatible without idempotency key', async () => {
    let captured = null;
    const res = response();
    await handleRaidRewardProposalIdempotentHttp(
        request({ decision: 'reject', note: 'Fora da regra' }),
        res,
        baseOptions({
            reviewRaidRewardProposal: async (_db, input) => {
                captured = input;
                return { ok: true };
            },
        })
    );

    assert.equal(res.statusCode, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(captured, 'idempotencyKey'), false);
});

test('proposal review conflict and stale intent errors map to HTTP 409', () => {
    for (const code of [
        'proposal_not_pending',
        'proposal_stale',
        'idempotency_conflict',
        'idempotency_in_progress',
        'idempotency_stale_intent',
        'idempotency_review_receipt_missing',
    ]) {
        assert.equal(statusForError(new RaidRewardProposalError(code, code)), 409, code);
    }
});

test('proposal review authorization and self-review errors map to HTTP 403', () => {
    for (const code of ['forbidden', 'self_review_blocked', 'raid_host_required']) {
        assert.equal(statusForError(new RaidRewardProposalError(code, code)), 403, code);
    }
});
