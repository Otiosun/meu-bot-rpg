'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    ensureCanonicalRoleGrantSchema,
} = require('../helpers/clover/canonicalRoleGrantSchema');
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

async function insertCanonicalRole(db, subjectId, roleKey) {
    await ensureCanonicalRoleGrantSchema(db);
    await db.run(
        `INSERT INTO clover_role_grants
         (subject_id, role_key, scope_type, scope_key, status,
          valid_from, granted_by, origin_type, origin_ref)
         VALUES (?, ?, 'global', '*', 'active',
                 '2000-01-01 00:00:00', '111@lid', 'fixture', ?)`,
        [subjectId, roleKey, `${subjectId}:${roleKey}`]
    );
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

test('Owner concede, altera e revoga perfil administrativo com fallback legado', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const granted = await setAdminRole(db, {
        actorId: '111@lid',
        targetId: '222@lid',
        role: 'evaluator',
    }, { ownerCheck });

    assert.equal(granted.ok, true);
    assert.equal(granted.actor.role, 'evaluator');
    assert.equal(granted.actor.source, 'admin_role');
    assert.equal(granted.actor.canonicalStatus, 'missing');
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

test('cargo canônico correspondente confirma a admissão legada sem ampliar capacidades', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await setAdminRole(db, {
        actorId: '111@lid',
        targetId: '222@lid',
        role: 'narrator',
    }, { ownerCheck });
    await insertCanonicalRole(db, '222@lid', 'narrator');

    const access = await getAdminActorAccess(db, '222@lid', { ownerCheck });
    assert.equal(access.ok, true);
    assert.equal(access.actor.role, 'narrator');
    assert.equal(access.actor.source, 'canonical_role_grant');
    assert.equal(access.actor.legacyAdmissionConfirmed, true);
    assert.equal(access.actor.canonicalGrantIds.length, 1);
    assert.equal(access.actor.capabilities.includes('raid.manage'), true);
    assert.equal(access.actor.capabilities.includes('operation.apply'), false);
});

test('cargo canônico sem admissão legada não entra na Central', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await insertCanonicalRole(db, '222@lid', 'evaluator');

    const access = await getAdminActorAccess(db, '222@lid', { ownerCheck });
    assert.equal(access.ok, false);
    assert.equal(access.code, 'canonical_admin_admission_unapproved');
    assert.equal(access.canonicalRole, 'evaluator');
});

test('divergência entre cargo legado e canônico falha fechada', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await setAdminRole(db, {
        actorId: '111@lid',
        targetId: '222@lid',
        role: 'assistant',
    }, { ownerCheck });
    await insertCanonicalRole(db, '222@lid', 'admin');

    const access = await getAdminActorAccess(db, '222@lid', { ownerCheck });
    assert.equal(access.ok, false);
    assert.equal(access.code, 'canonical_admin_role_mismatch');
    assert.equal(access.legacyRole, 'assistant');
    assert.equal(access.canonicalRole, 'admin');
});

test('múltiplos cargos canônicos administrativos falham fechados', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await setAdminRole(db, {
        actorId: '111@lid',
        targetId: '222@lid',
        role: 'admin',
    }, { ownerCheck });
    await insertCanonicalRole(db, '222@lid', 'admin');
    await insertCanonicalRole(db, '222@lid', 'evaluator');

    const access = await getAdminActorAccess(db, '222@lid', { ownerCheck });
    assert.equal(access.ok, false);
    assert.equal(access.code, 'ambiguous_canonical_admin_role');
    assert.deepEqual(access.roleKeys, ['admin', 'evaluator']);
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
