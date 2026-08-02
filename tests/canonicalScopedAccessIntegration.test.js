'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    assignAccessRole,
    hasAccessPermission,
} = require('../helpers/clover/accessControlService');
const {
    ACCESS_PERMISSIONS,
    authorizeCharacterAccess,
    authorizeSquadAccess,
} = require('../helpers/clover/accessIntegrationService');
const {
    ensureCanonicalRoleGrantSchema,
} = require('../helpers/clover/canonicalRoleGrantSchema');

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

const alphaPlayer = Object.freeze({
    id: 'target-alpha@lid',
    esquadrao: 'alpha',
});
const betaPlayer = Object.freeze({
    id: 'target-beta@lid',
    esquadrao: 'beta',
});

test('Capitão canônico acessa somente personagens do próprio esquadrão', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await insertCanonicalRole(db, 'captain@lid', 'captain', 'squad', 'alpha');

    const own = await authorizeCharacterAccess(db, {
        actorId: 'captain@lid',
        targetPlayer: alphaPlayer,
        permission: ACCESS_PERMISSIONS.PROFILE_READ,
        allowSelf: false,
    });
    assert.equal(own.ok, true);
    assert.equal(own.code, 'squad_role');
    assert.equal(own.reader, 'canonical_scoped');
    assert.equal(own.assignment.source, 'canonical_role_grant');

    const foreign = await authorizeCharacterAccess(db, {
        actorId: 'captain@lid',
        targetPlayer: betaPlayer,
        permission: ACCESS_PERMISSIONS.PROFILE_READ,
        allowSelf: false,
    });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.code, 'forbidden');
    assert.equal(foreign.fallbackAllowed, false);
});

test('grant canônico existente impede fallback legado mais permissivo', async (t) => {
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

    const result = await authorizeCharacterAccess(db, {
        actorId: 'captain@lid',
        targetPlayer: betaPlayer,
        permission: ACCESS_PERMISSIONS.PROFILE_READ,
        allowSelf: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'forbidden');
    assert.equal(result.fallbackAllowed, false);
});

test('fonte legada permanece fallback quando não existe grant canônico operacional', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await assignAccessRole(db, {
        subjectId: 'legacy-captain@lid',
        role: 'captain',
        scopeKey: 'alpha',
        assignedBy: 'owner@lid',
        reason: 'fixture legado',
    });

    const result = await authorizeCharacterAccess(db, {
        actorId: 'legacy-captain@lid',
        targetPlayer: alphaPlayer,
        permission: ACCESS_PERMISSIONS.PROFILE_READ,
        allowSelf: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.code, 'squad_role');
    assert.equal(result.reader, 'legacy_scoped_fallback');
});

test('Avaliador canônico preserva permissões técnicas integradas', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await insertCanonicalRole(db, 'evaluator@lid', 'evaluator');

    const capacity = await authorizeCharacterAccess(db, {
        actorId: 'evaluator@lid',
        targetPlayer: alphaPlayer,
        permission: ACCESS_PERMISSIONS.CAPACITY_TECHNICAL,
        allowSelf: false,
    });
    assert.equal(capacity.ok, true);
    assert.equal(capacity.code, 'global_role');
    assert.equal(capacity.reader, 'canonical_scoped');
    assert.equal(capacity.assignment.role_key, 'evaluator');
});

test('Capitão canônico preserva gestão escopada de esquadrão e benfeitorias', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await insertCanonicalRole(db, 'captain@lid', 'captain', 'squad', 'alpha');

    const own = await authorizeSquadAccess(db, {
        actorId: 'captain@lid',
        squad: 'alpha',
        permission: ACCESS_PERMISSIONS.SQUAD_UPGRADES_MANAGE,
        allowMemberRead: false,
    });
    assert.equal(own.ok, true);
    assert.equal(own.code, 'squad_role');
    assert.equal(own.reader, 'canonical_scoped');

    const foreign = await authorizeSquadAccess(db, {
        actorId: 'captain@lid',
        squad: 'beta',
        permission: ACCESS_PERMISSIONS.SQUAD_UPGRADES_MANAGE,
        allowMemberRead: false,
    });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.code, 'forbidden');
    assert.equal(foreign.fallbackAllowed, false);
});

test('helper genérico não é conectado implicitamente aos grants canônicos', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await insertCanonicalRole(db, 'captain@lid', 'captain', 'squad', 'alpha');

    const generic = await hasAccessPermission(
        db,
        'captain@lid',
        ACCESS_PERMISSIONS.SQUAD_MEMBERS_MANAGE
    );
    assert.equal(generic, false);
});
