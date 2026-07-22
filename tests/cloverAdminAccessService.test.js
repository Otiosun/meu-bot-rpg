'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    AdminAccessError,
    getAdminActorAccess,
    listAdminRoles,
    revokeAdminRole,
    setAdminRole,
} = require('../helpers/clover/adminAccessService');

async function createDb() {
    return open({ filename: ':memory:', driver: sqlite3.Database });
}

const ownerCheck = (jid) => jid === '111@lid';

test('Owner recebe acesso total sem linha no banco', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const access = await getAdminActorAccess(db, '111@lid', { ownerCheck });
    assert.equal(access.ok, true);
    assert.equal(access.actor.role, 'owner');
    assert.equal(access.actor.source, 'owner_config');
    assert.equal(access.actor.capabilities.includes('player.identity.repair'), true);

    const rows = await listAdminRoles(db);
    assert.deepEqual(rows, []);
});

test('Owner concede, altera e revoga perfil administrativo', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const granted = await setAdminRole(db, {
        actorId: '111@lid',
        targetId: '222@lid',
        role: 'evaluator',
    }, { ownerCheck });

    assert.equal(granted.ok, true);
    assert.equal(granted.actor.role, 'evaluator');
    assert.equal(granted.actor.capabilities.includes('catalog.manage.traits'), true);
    assert.equal(granted.actor.capabilities.includes('resource.adjust'), false);

    const changed = await setAdminRole(db, {
        actorId: '111@lid',
        targetId: '222@lid',
        role: 'admin',
    }, { ownerCheck });
    assert.equal(changed.actor.role, 'admin');
    assert.equal(changed.actor.capabilities.includes('resource.adjust'), true);

    const revoked = await revokeAdminRole(db, {
        actorId: '111@lid',
        targetId: '222@lid',
    }, { ownerCheck });
    assert.equal(revoked.changed, true);

    const denied = await getAdminActorAccess(db, '222@lid', { ownerCheck });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'admin_access_denied');
});

test('ADM comum não pode conceder funções', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await setAdminRole(db, {
        actorId: '111@lid',
        targetId: '222@lid',
        role: 'admin',
    }, { ownerCheck });

    await assert.rejects(() => setAdminRole(db, {
        actorId: '222@lid',
        targetId: '333@lid',
        role: 'assistant',
    }, { ownerCheck }), (error) => {
        assert.equal(error instanceof AdminAccessError, true);
        assert.equal(error.code, 'owner_required');
        return true;
    });
});

test('perfil owner não pode ser gravado manualmente', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await assert.rejects(() => setAdminRole(db, {
        actorId: '111@lid',
        targetId: '222@lid',
        role: 'owner',
    }, { ownerCheck }), { code: 'unassignable_admin_role' });
});
