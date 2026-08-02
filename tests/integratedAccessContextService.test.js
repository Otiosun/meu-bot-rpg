'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    assignAccessRole,
} = require('../helpers/clover/accessControlService');
const {
    ensureCanonicalRoleGrantSchema,
} = require('../helpers/clover/canonicalRoleGrantSchema');
const {
    contextCanAnywhere,
    contextCanForSquad,
    contextHasGlobalAdministration,
    getIntegratedAccessContext,
} = require('../helpers/clover/integratedAccessContextService');

async function createDb() {
    return open({ filename: ':memory:', driver: sqlite3.Database });
}

async function insertCanonicalRole(db, subjectId, roleKey, scopeType = 'global', scopeKey = '*') {
    await ensureCanonicalRoleGrantSchema(db);
    await db.run(
        `INSERT INTO clover_role_grants
         (subject_id, role_key, scope_type, scope_key, status,
          valid_from, granted_by, origin_type, origin_ref)
         VALUES (?, ?, ?, ?, 'active',
                 '2000-01-01 00:00:00', 'owner@lid', 'fixture', ?)`,
        [subjectId, roleKey, scopeType, scopeKey, `${subjectId}:${roleKey}:${scopeKey}`]
    );
}

test('Capitão canônico mantém capacidades no assignment sem achatá-las em permissions', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await insertCanonicalRole(db, 'captain@lid', 'captain', 'squad', 'alpha');

    const context = await getIntegratedAccessContext(db, 'captain@lid');
    assert.equal(context.source, 'canonical_role_grants');
    assert.deepEqual(context.roleKeys, ['captain']);
    assert.deepEqual(context.squadScopes, ['alpha']);
    assert.deepEqual(context.permissions, []);
    assert.equal(contextCanAnywhere(context, 'squad.manage.members'), true);
    assert.equal(contextCanForSquad(context, 'squad.manage.members', 'alpha'), true);
    assert.equal(contextCanForSquad(context, 'squad.manage.members', 'beta'), false);
    assert.equal(contextHasGlobalAdministration(context), false);
});

test('Admin canônico expõe permissões globais explícitas sem wildcard', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await insertCanonicalRole(db, 'admin@lid', 'admin');

    const context = await getIntegratedAccessContext(db, 'admin@lid');
    assert.equal(context.source, 'canonical_role_grants');
    assert.equal(contextHasGlobalAdministration(context), true);
    assert.equal(context.permissions.includes('*'), false);
    assert.equal(context.permissions.includes('character.read.profile'), true);
    assert.equal(context.permissions.includes('raid.reward.review'), true);
    assert.equal(contextCanForSquad(context, 'squad.manage.members', 'alpha'), true);
});

test('Narrador canônico preserva expansão aprovada sem receber revisão', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await insertCanonicalRole(db, 'narrator@lid', 'narrator');

    const context = await getIntegratedAccessContext(db, 'narrator@lid');
    assert.equal(contextCanAnywhere(context, 'raid.reward.propose'), true);
    assert.equal(contextCanAnywhere(context, 'raid.read.all'), true);
    assert.equal(contextCanAnywhere(context, 'raid.reward.review'), false);
});

test('fonte canônica é autoritativa sobre assignment legado divergente', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await insertCanonicalRole(db, 'captain@lid', 'captain', 'squad', 'alpha');
    await assignAccessRole(db, {
        subjectId: 'captain@lid',
        role: 'captain',
        scopeKey: 'beta',
        assignedBy: 'owner@lid',
        reason: 'fixture divergente',
    });

    const context = await getIntegratedAccessContext(db, 'captain@lid');
    assert.equal(context.source, 'canonical_role_grants');
    assert.deepEqual(context.squadScopes, ['alpha']);
    assert.equal(contextCanForSquad(context, 'squad.manage.members', 'beta'), false);
});

test('sujeito ainda não migrado usa fallback legado sem permissões escopadas globais', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await assignAccessRole(db, {
        subjectId: 'legacy-captain@lid',
        role: 'captain',
        scopeKey: 'alpha',
        assignedBy: 'owner@lid',
        reason: 'fixture legado',
    });

    const context = await getIntegratedAccessContext(db, 'legacy-captain@lid');
    assert.equal(context.source, 'legacy_access_fallback');
    assert.deepEqual(context.permissions, []);
    assert.deepEqual(context.squadScopes, ['alpha']);
    assert.equal(contextCanAnywhere(context, 'squad.manage.members'), true);
    assert.equal(contextCanForSquad(context, 'squad.manage.members', 'alpha'), true);
    assert.equal(contextCanForSquad(context, 'squad.manage.members', 'beta'), false);
});

test('Owner mantém wildcard global apenas pela configuração', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const context = await getIntegratedAccessContext(db, 'owner@lid', {
        ownerCheck: (jid) => jid === 'owner@lid',
    });
    assert.equal(context.owner, true);
    assert.deepEqual(context.permissions, ['*']);
    assert.equal(contextHasGlobalAdministration(context), true);
    assert.equal(contextCanForSquad(context, 'squad.manage.members', 'alpha'), true);
});
