'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    handleAdminSkillTreeHttp,
    parseAdminSkillTreePath,
} = require('../helpers/clover/adminSkillTreeHttp');

function responseHarness() {
    let body = '';
    const headers = {};
    return {
        res: {
            statusCode: 200,
            setHeader(name, value) { headers[name] = value; },
            end(value = '') { body = String(value); },
        },
        read() {
            return {
                status: this.res.statusCode,
                headers,
                body: body ? JSON.parse(body) : null,
            };
        },
    };
}

function contextWith(capabilities = ['catalog.view']) {
    return {
        db: {},
        access: {
            actor: {
                id: 'admin@test',
                capabilities,
            },
        },
    };
}

test('skill tree admin path parser distinguishes dashboard and detail', () => {
    assert.deepEqual(parseAdminSkillTreePath('/admin/skill-trees'), { kind: 'dashboard' });
    assert.deepEqual(parseAdminSkillTreePath('/admin/skill-trees/mana'), { kind: 'tree', treeId: 'mana' });
    assert.equal(parseAdminSkillTreePath('/admin/skill-tree'), null);
});

test('skill tree dashboard is read-only and capability protected', async () => {
    const harness = responseHarness();
    const handled = await handleAdminSkillTreeHttp(
        { method: 'GET', url: '/admin/skill-trees', headers: {} },
        harness.res,
        {
            resolveAdminContext: async () => contextWith(),
            adminSkillTreeDashboard: async (_db, options) => ({
                ok: true,
                actorId: options.actorId,
                trees: [{ id: 'mana', activeVersion: 1 }],
            }),
        }
    );
    assert.equal(handled, true);
    const reply = harness.read();
    assert.equal(reply.status, 200);
    assert.equal(reply.body.ok, true);
    assert.equal(reply.body.actorId, 'admin@test');
    assert.equal(reply.body.trees[0].id, 'mana');
});

test('skill tree detail forwards canonical tree id to resolver', async () => {
    const harness = responseHarness();
    await handleAdminSkillTreeHttp(
        { method: 'GET', url: '/admin/skill-trees/reforco', headers: {} },
        harness.res,
        {
            resolveAdminContext: async () => contextWith(),
            adminSkillTreeDetail: async (_db, treeId) => ({
                ok: true,
                treeId,
                versions: [],
            }),
        }
    );
    const reply = harness.read();
    assert.equal(reply.status, 200);
    assert.equal(reply.body.treeId, 'reforco');
});

test('skill tree reads fail closed without catalog.view', async () => {
    const harness = responseHarness();
    await handleAdminSkillTreeHttp(
        { method: 'GET', url: '/admin/skill-trees', headers: {} },
        harness.res,
        {
            resolveAdminContext: async () => contextWith([]),
            adminSkillTreeDashboard: async () => ({ ok: true, trees: [] }),
        }
    );
    const reply = harness.read();
    assert.equal(reply.status, 403);
    assert.equal(reply.body.error, 'missing_capability');
});
