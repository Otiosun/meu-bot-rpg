'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { SKILL_APPROVAL_ROUTE_DESCRIPTORS, handleSkillApprovalHttp } = require('../helpers/clover/skillApprovalHttp');
const { matchDescriptor } = require('../helpers/clover/httpRouteDescriptor');

function req(method, url, body = null, headers = {}) {
    const stream = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))]);
    stream.method = method;
    stream.url = url;
    stream.headers = {
        authorization: 'Bearer token',
        'content-type': 'application/json',
        ...headers,
    };
    return stream;
}

function res() {
    return {
        statusCode: 0,
        headers: {},
        body: '',
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
        end(value = '') { this.body += String(value || ''); },
    };
}

function baseOptions(overrides = {}) {
    return {
        getDb: () => ({ isolated: true }),
        authenticateSession: async () => ({ ok: true, player: { id: 'player@test' } }),
        getPlayerPhase: async () => ({ canPlay: true, phase: 'active' }),
        accessResolver: async () => ({
            ok: true,
            actor: {
                id: 'admin@test',
                role: 'admin',
                capabilities: ['player.manage'],
            },
        }),
        mutationRunner: async (operation) => operation(),
        ...overrides,
    };
}

function treeState(status = 'available') {
    return {
        playerId: 'player@test',
        tree: {
            id: 'mana',
            name: 'Mana',
            routes: [],
            nodes: [],
            edges: [],
            goals: [],
        },
        ph: 20,
        discount: { percent: 0, sources: [] },
        ownedIds: [],
        totalNodes: 1,
        ownedCount: 0,
        routeProgress: [],
        nodeStates: [{
            node: { id: 'mana_normal', name: 'Normal', cost: 5 },
            status,
            missingPh: 0,
            missingRequirements: [],
            missingRequirementLabels: [],
            satisfiedRequirements: [],
            satisfiedRequirementLabels: [],
            baseCost: 5,
            effectiveCost: 5,
            discount: { percent: 0, sources: [] },
        }],
        availableNodes: [],
    };
}

test('skill approval descriptors distinguish review commands from reads', () => {
    assert.equal(matchDescriptor(SKILL_APPROVAL_ROUTE_DESCRIPTORS, 'POST', '/trees/mana/purchase')?.id, 'skill.tree.purchase');
    assert.equal(matchDescriptor(SKILL_APPROVAL_ROUTE_DESCRIPTORS, 'GET', '/trees/mana/purchase'), null);
    assert.equal(matchDescriptor(SKILL_APPROVAL_ROUTE_DESCRIPTORS, 'POST', '/admin/skill-approvals/SA-1/approve')?.id, 'admin.skill-approvals.approve');
    assert.equal(matchDescriptor(SKILL_APPROVAL_ROUTE_DESCRIPTORS, 'GET', '/admin/skill-approvals/SA-1/approve'), null);
});

test('approval node creates pending request without normal purchase', async () => {
    let requested = 0;
    let purchased = 0;
    const response = res();

    const handled = await handleSkillApprovalHttp(
        req('POST', '/trees/mana/purchase', { nodeId: 'mana_approval' }),
        response,
        baseOptions({
            getNodeDetails: async () => ({
                ok: true,
                state: treeState('approval'),
                node: { id: 'mana_approval', name: 'Approval', cost: 5 },
                nodeState: {
                    status: 'approval',
                    effectiveCost: 5,
                    discount: { percent: 0, sources: [] },
                },
            }),
            requestSkillApproval: async (_db, playerId, treeId, nodeId, requestedBy) => {
                requested += 1;
                assert.equal(playerId, 'player@test');
                assert.equal(treeId, 'mana');
                assert.equal(nodeId, 'mana_approval');
                assert.equal(requestedBy, 'player@test');
                return {
                    ok: true,
                    created: true,
                    request: { request_key: 'SAR-test', status: 'pending' },
                };
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
    assert.equal(payload.ok, true);
    assert.equal(payload.requiresApproval, true);
    assert.equal(payload.requires_approval, true);
    assert.equal(payload.applied, false);
    assert.equal(payload.request.status, 'pending');
});

test('ordinary available node keeps purchase path', async () => {
    let requested = 0;
    let purchased = 0;
    const response = res();

    await handleSkillApprovalHttp(
        req('POST', '/trees/mana/purchase', { nodeAlias: 'mana_normal' }),
        response,
        baseOptions({
            getNodeDetails: async () => ({
                ok: true,
                state: treeState('available'),
                node: { id: 'mana_normal', name: 'Normal', cost: 5 },
                nodeState: {
                    status: 'available',
                    effectiveCost: 5,
                    discount: { percent: 0, sources: [] },
                },
            }),
            requestSkillApproval: async () => {
                requested += 1;
                return { ok: true };
            },
            buyNode: async (_db, playerId, treeId, nodeAlias) => {
                purchased += 1;
                assert.equal(playerId, 'player@test');
                assert.equal(treeId, 'mana');
                assert.equal(nodeAlias, 'mana_normal');
                return {
                    ok: true,
                    tree: treeState().tree,
                    node: { id: 'mana_normal', name: 'Normal', cost: 5 },
                    cost: 5,
                    baseCost: 5,
                    discount: { percent: 0, sources: [] },
                    purchaseId: 7,
                    spend: { ok: true },
                    state: treeState('available'),
                };
            },
        })
    );

    assert.equal(response.statusCode, 200);
    assert.equal(requested, 0);
    assert.equal(purchased, 1);

    const payload = JSON.parse(response.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.purchase.purchaseId, 7);
});

test('game phase remains fail-closed before tree mutation', async () => {
    let detailsCalls = 0;
    const response = res();

    await handleSkillApprovalHttp(
        req('POST', '/trees/mana/purchase', { nodeId: 'mana_approval' }),
        response,
        baseOptions({
            getPlayerPhase: async () => ({ canPlay: false, phase: 'blocked' }),
            getNodeDetails: async () => {
                detailsCalls += 1;
                return { ok: false };
            },
        })
    );

    assert.equal(response.statusCode, 403);
    assert.equal(detailsCalls, 0);
    const payload = JSON.parse(response.body);
    assert.equal(payload.error, 'game_blocked');
});

test('admin list requires player.manage', async () => {
    const response = res();
    let listed = 0;

    await handleSkillApprovalHttp(
        req('GET', '/admin/skill-approvals?status=pending'),
        response,
        baseOptions({
            accessResolver: async () => ({
                ok: true,
                actor: {
                    id: 'viewer@test',
                    role: 'viewer',
                    capabilities: ['operation.view'],
                },
            }),
            listSkillApprovals: async () => {
                listed += 1;
                return [];
            },
        })
    );

    assert.equal(response.statusCode, 403);
    assert.equal(listed, 0);
    const payload = JSON.parse(response.body);
    assert.ok(['missing_capability', 'skill_approval_review_forbidden'].includes(payload.error));
});

test('admin list uses current service override without touching live DB', async () => {
    const response = res();
    let listed = 0;

    await handleSkillApprovalHttp(
        req('GET', '/admin/skill-approvals?status=pending&limit=5'),
        response,
        baseOptions({
            listSkillApprovals: async (_db, query) => {
                listed += 1;
                assert.equal(query.status, 'pending');
                assert.equal(Number(query.limit), 5);
                return [{ request_key: 'SAR-list', status: 'pending' }];
            },
        })
    );

    assert.equal(response.statusCode, 200);
    assert.equal(listed, 1);
    const payload = JSON.parse(response.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.requests.length, 1);
});

test('admin approve/reject forwards request ref and reviewer without HTTP PH side effects', async () => {
    for (const decision of ['approve', 'reject']) {
        const response = res();
        let captured = null;

        await handleSkillApprovalHttp(
            req(
                'POST',
                `/admin/skill-approvals/SAR-test/${decision}`,
                { reason: 'revisado' },
                { 'x-request-id': `req-${decision}` }
            ),
            response,
            baseOptions({
                approveSkillApproval: async (_db, requestRef, actorId, reason) => {
                    captured = { decision: 'approve', requestRef, actorId, reason };
                    return { ok: true, request: { status: 'approved' } };
                },
                rejectSkillApproval: async (_db, requestRef, actorId, reason) => {
                    captured = { decision: 'reject', requestRef, actorId, reason };
                    return { ok: true, request: { status: 'rejected' } };
                },
            })
        );

        assert.equal(response.statusCode, 200);
        assert.deepEqual(captured, {
            decision,
            requestRef: 'SAR-test',
            actorId: 'admin@test',
            reason: 'revisado',
        });
    }
});


test('admin review also requires player.manage', async () => {
    const response = res();
    let reviewCalls = 0;

    await handleSkillApprovalHttp(
        req(
            'POST',
            '/admin/skill-approvals/SAR-blocked/approve',
            { reason: 'should not run' }
        ),
        response,
        baseOptions({
            accessResolver: async () => ({
                ok: true,
                actor: {
                    id: 'viewer@test',
                    role: 'admin',
                    capabilities: ['operation.view'],
                },
            }),
            approveSkillApproval: async () => {
                reviewCalls += 1;
                return { ok: true };
            },
        })
    );

    assert.equal(response.statusCode, 403);
    assert.equal(reviewCalls, 0);

    const payload = JSON.parse(response.body);
    assert.equal(payload.error, 'missing_capability');
    assert.equal(payload.details.capability, 'player.manage');
});
