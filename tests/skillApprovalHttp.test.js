'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { handleSkillApprovalHttp } = require('../helpers/clover/skillApprovalHttp');

function req(method, url, body = null) {
    const stream = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))]);
    stream.method = method;
    stream.url = url;
    stream.headers = { authorization: 'Bearer token' };
    return stream;
}

function res() {
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
        authenticateSession: async () => ({ ok: true, player: { id: 'player@test' } }),
        accessResolver: async () => ({
            ok: true,
            actor: { id: 'admin@test', role: 'admin', capabilities: ['player.manage'] },
        }),
        mutationRunner: async (operation) => operation(),
        ...overrides,
    };
}

test('requiresApproval creates persistent request and never calls normal purchase', async () => {
    let requested = 0;
    let purchased = 0;
    const response = res();

    const handled = await handleSkillApprovalHttp(
        req('POST', '/trees/mana/purchase', { nodeId: 'mana_approval' }),
        response,
        options({
            getNodeDetails: async () => ({
                ok: true,
                nodeState: { status: 'approval' },
            }),
            requestSkillApproval: async (_db, playerId, treeId, nodeAlias, requestedBy) => {
                requested += 1;
                assert.equal(playerId, 'player@test');
                assert.equal(treeId, 'mana');
                assert.equal(nodeAlias, 'mana_approval');
                assert.equal(requestedBy, 'player@test');
                return { ok: true, request: { request_key: 'SAR-test', status: 'pending' } };
            },
            buyNode: async () => {
                purchased += 1;
                return { ok: true };
            },
        })
    );

    assert.equal(handled, true);
    assert.equal(response.statusCode, 202);
    assert.equal(requested, 1);
    assert.equal(purchased, 0);
    const payload = JSON.parse(response.body);
    assert.equal(payload.requiresApproval, true);
    assert.equal(payload.applied, false);
});

test('ordinary available node keeps normal purchase path', async () => {
    let requested = 0;
    let purchased = 0;
    const response = res();

    await handleSkillApprovalHttp(
        req('POST', '/trees/mana/purchase', { nodeAlias: 'mana_normal' }),
        response,
        options({
            getNodeDetails: async () => ({ ok: true, nodeState: { status: 'available' } }),
            requestSkillApproval: async () => {
                requested += 1;
                return { ok: true };
            },
            buyNode: async (_db, playerId, treeId, nodeAlias) => {
                purchased += 1;
                assert.equal(playerId, 'player@test');
                assert.equal(treeId, 'mana');
                assert.equal(nodeAlias, 'mana_normal');
                return { ok: true, purchaseId: 7 };
            },
        })
    );

    assert.equal(response.statusCode, 200);
    assert.equal(requested, 0);
    assert.equal(purchased, 1);
    assert.equal(JSON.parse(response.body).applied, true);
});

test('admin list is fail-closed behind player.manage', async () => {
    const response = res();
    await handleSkillApprovalHttp(
        req('GET', '/admin/skill-approvals?status=pending'),
        response,
        options({
            accessResolver: async () => ({
                ok: true,
                actor: { id: 'viewer@test', capabilities: ['operation.view'] },
            }),
            listSkillApprovals: async () => {
                throw new Error('must not list');
            },
        })
    );
    assert.equal(response.statusCode, 403);
    assert.equal(JSON.parse(response.body).error, 'missing_capability');
});

test('admin approve and reject forward the same request reference without PH-side effects in HTTP', async () => {
    for (const decision of ['approve', 'reject']) {
        let captured = null;
        const response = res();
        await handleSkillApprovalHttp(
            req('POST', `/admin/skill-approvals/SAR-test/${decision}`, { reason: 'revisado' }),
            response,
            options({
                approveSkillApproval: async (_db, requestRef, actorId, reason) => {
                    captured = { requestRef, actorId, reason, decision: 'approve' };
                    return { ok: true, request: { status: 'approved' } };
                },
                rejectSkillApproval: async (_db, requestRef, actorId, reason) => {
                    captured = { requestRef, actorId, reason, decision: 'reject' };
                    return { ok: true, request: { status: 'rejected' } };
                },
            })
        );
        assert.equal(response.statusCode, 200);
        assert.deepEqual(captured, {
            requestRef: 'SAR-test',
            actorId: 'player@test',
            reason: 'revisado',
            decision,
        });
    }
});
