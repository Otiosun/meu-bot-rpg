'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    handleAdminMissionHttp,
    parseAdminMissionPath,
} = require('../helpers/clover/adminMissionHttp');
const {
    createMissionExecutors,
} = require('../helpers/clover/adminMissionService');

async function makeDb() {
    return open({ filename: ':memory:', driver: sqlite3.Database });
}

function harness() {
    let body = '';
    return {
        res: {
            statusCode: 200,
            setHeader() {},
            end(value = '') { body = String(value); },
        },
        read() {
            return {
                status: this.res.statusCode,
                body: body ? JSON.parse(body) : null,
            };
        },
    };
}

function context(db, capabilities = ['catalog.view']) {
    return {
        db,
        access: { actor: { id: 'admin-1', capabilities } },
    };
}

function mission() {
    return {
        missionKey: 'mural-http-01',
        title: 'Missão HTTP',
        rank: 'E',
        mode: 'official',
        location: 'Capital',
        missionType: 'support',
        risk: 'Baixo.',
        slots: 2,
        deadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
        reward: { ph: [3, 8], stars: [0, 1], yulls: [500, 900] },
        description: 'Apoio civil.',
        countsForSalary: true,
    };
}

test('mission admin parser distinguishes list and detail', () => {
    assert.deepEqual(parseAdminMissionPath('/admin/missions'), { kind: 'list' });
    assert.deepEqual(parseAdminMissionPath('/admin/missions/mural-http-01'), {
        kind: 'detail',
        missionKey: 'mural-http-01',
    });
    assert.equal(parseAdminMissionPath('/admin/mission'), null);
});

test('mission read API lists and fetches canonical mission records', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const action = { type: 'system.mission.create', payload: mission() };
    const executor = createMissionExecutors()['system.mission.create'];
    const preview = await executor.preview({
        db,
        operation: { actor: { id: 'admin-1' }, reason: 'teste' },
        action,
        target: { kind: 'system', systemKey: 'clover' },
    });
    await executor.apply({
        db,
        operation: { actor: { id: 'admin-1' }, reason: 'teste' },
        action,
        target: { kind: 'system', systemKey: 'clover' },
        after: preview.after,
    });

    const listHarness = harness();
    await handleAdminMissionHttp(
        { method: 'GET', url: '/admin/missions', headers: {} },
        listHarness.res,
        { resolveAdminContext: async () => context(db) }
    );
    assert.equal(listHarness.read().status, 200);
    assert.equal(listHarness.read().body.missions.length, 1);
    assert.equal(listHarness.read().body.rankGuide.E.yulls[0], 500);

    const detailHarness = harness();
    await handleAdminMissionHttp(
        { method: 'GET', url: '/admin/missions/mural-http-01', headers: {} },
        detailHarness.res,
        { resolveAdminContext: async () => context(db) }
    );
    assert.equal(detailHarness.read().status, 200);
    assert.equal(detailHarness.read().body.mission.title, 'Missão HTTP');
});

test('mission read API fails closed without catalog.view', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const blocked = harness();
    await handleAdminMissionHttp(
        { method: 'GET', url: '/admin/missions', headers: {} },
        blocked.res,
        { resolveAdminContext: async () => context(db, []) }
    );
    assert.equal(blocked.read().status, 403);
    assert.equal(blocked.read().body.error, 'missing_capability');
});
