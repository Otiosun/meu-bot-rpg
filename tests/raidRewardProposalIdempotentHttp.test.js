'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const {
    handleRaidRewardProposalIdempotentHttp,
} = require('../helpers/clover/raidRewardProposalIdempotentHttp');

function request(body, headers = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
    req.method = 'POST';
    req.url = '/raid-reward-proposals/42/review';
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

test('proposal review forwards decision, note and Idempotency-Key', async () => {
    let captured = null;
    const res = response();
    const handled = await handleRaidRewardProposalIdempotentHttp(
        request(
            { decision: 'return', note: 'Ajustar recompensa' },
            { 'idempotency-key': 'proposal-review-key-1' }
        ),
        res,
        {
            getDb: () => ({ fake: true }),
            authenticateSession: async () => ({ ok: true, player: { id: 'reviewer@test' } }),
            mutationRunner: async (operation) => operation(),
            reviewRaidRewardProposal: async (_db, input) => {
                captured = input;
                return { ok: true, proposal: { id: '42', status: 'returned' } };
            },
        }
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(captured.proposalId, '42');
    assert.equal(captured.actorId, 'reviewer@test');
    assert.equal(captured.decision, 'return');
    assert.equal(captured.note, 'Ajustar recompensa');
    assert.equal(captured.idempotencyKey, 'proposal-review-key-1');
});
