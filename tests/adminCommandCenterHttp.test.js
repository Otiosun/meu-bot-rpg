'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    handleAdminCommandCenterHttp,
} = require('../helpers/clover/adminCommandCenterHttp');

function responseMock() {
    return {
        statusCode: 0,
        headers: {},
        body: '',
        setHeader(name, value) {
            this.headers[String(name).toLowerCase()] = value;
        },
        end(value = '') {
            this.body += String(value);
        },
    };
}

function inboxFixture() {
    const items = [
        { id: 'op', category: 'operation', priority: 'high' },
        { id: 'raid', category: 'raid_reward_proposal', priority: 'high' },
        { id: 'team', category: 'admin_role_change', priority: 'medium' },
        { id: 'integrity', category: 'integrity', priority: 'critical' },
        { id: 'stars', category: 'stars_integrity', priority: 'critical' },
    ];
    return {
        ok: true,
        readOnly: true,
        items,
        sections: {
            operations: [items[0]],
            raidRewardProposals: [items[1]],
            adminRoleChanges: [items[2]],
            integrity: { summary: { total: 7 }, issues: [] },
            starAnomalies: [items[4]],
        },
    };
}

function historyFixture() {
    return {
        ok: true,
        readOnly: true,
        events: [
            { id: 'op', type: 'operation' },
            { id: 'team', type: 'admin_role' },
            { id: 'raid', type: 'raid_reward_proposal' },
        ],
        sources: { operations: 1, adminRoles: 1, raidRewardProposals: 1 },
    };
}

async function invoke(path, access, overrides = {}) {
    const req = { method: overrides.method || 'GET', url: path, headers: {} };
    const res = responseMock();
    const handled = await handleAdminCommandCenterHttp(req, res, {
        resolveAdminContext: async () => ({ db: {}, access }),
        commandCenterResolver: async () => inboxFixture(),
        commandHistoryResolver: async () => historyFixture(),
    });
    return { handled, res, payload: res.body ? JSON.parse(res.body) : null };
}

test('owner recebe todas as categorias da inbox e do historico', async () => {
    const access = {
        actor: {
            role: 'owner',
            capabilities: ['operation.view', 'raid.view', 'integrity.view'],
        },
    };
    const inbox = await invoke('/admin/inbox', access);
    assert.equal(inbox.handled, true);
    assert.equal(inbox.res.statusCode, 200);
    assert.equal(inbox.payload.items.length, 5);
    assert.equal(inbox.payload.summary.adminRoleChanges, 1);

    const history = await invoke('/admin/history', access);
    assert.deepEqual(
        history.payload.events.map((event) => event.type).sort(),
        ['admin_role', 'operation', 'raid_reward_proposal']
    );
});

test('avaliador nao recebe cargos ou integridade sem capacidade', async () => {
    const access = {
        actor: {
            role: 'evaluator',
            capabilities: ['operation.view', 'raid.reward.review'],
        },
    };
    const inbox = await invoke('/admin/inbox', access);
    assert.equal(inbox.res.statusCode, 200);
    assert.deepEqual(
        inbox.payload.items.map((item) => item.category).sort(),
        ['operation', 'raid_reward_proposal']
    );
    assert.equal(inbox.payload.sections.integrity, null);
    assert.deepEqual(inbox.payload.sections.adminRoleChanges, []);

    const history = await invoke('/admin/history', access);
    assert.deepEqual(
        history.payload.events.map((event) => event.type).sort(),
        ['operation', 'raid_reward_proposal']
    );
});

test('perfil sem capacidade e metodo de escrita falham fechados', async () => {
    const denied = await invoke('/admin/inbox', {
        actor: { role: 'assistant', capabilities: [] },
    });
    assert.equal(denied.res.statusCode, 403);
    assert.equal(denied.payload.error, 'missing_capability');

    const invalidMethod = await invoke('/admin/inbox', {
        actor: { role: 'admin', capabilities: ['operation.view'] },
    }, { method: 'POST' });
    assert.equal(invalidMethod.res.statusCode, 405);
    assert.equal(invalidMethod.payload.error, 'method_not_allowed');
});
