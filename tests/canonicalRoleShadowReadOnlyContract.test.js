'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const normalizeJid = (value) => String(value || '').trim().toLowerCase() || null;
const definitions = {
    evaluator: {
        permissions: [
            'character.read.profile',
            'character.read.progress',
            'character.read.capacity',
            'character.read.grimoire',
            'evaluation.apply',
            'raid.reward.review',
        ],
    },
    captain: {
        permissions: [
            'character.read.profile',
            'squad.read.members',
            'squad.manage.members',
            'raid.manage',
            'raid.reward.propose',
        ],
    },
};

function rowToGrant(row, source = 'canonical') {
    return {
        id: row.id ?? null,
        subjectId: row.subject_id,
        roleKey: row.role_key,
        scopeType: row.scope_type,
        scopeKey: row.scope_key,
        status: row.status || 'active',
        validFrom: row.valid_from || row.created_at || null,
        validUntil: row.valid_until || null,
        grantedBy: row.granted_by || row.assigned_by || null,
        source,
    };
}

function isGrantActiveAt(grant, referenceDate = new Date()) {
    if (grant.status !== 'active') return false;
    const now = new Date(referenceDate);
    if (grant.validFrom && new Date(grant.validFrom) > now) return false;
    if (grant.validUntil && new Date(grant.validUntil) <= now) return false;
    return true;
}

async function tableExists(db, tableName) {
    return Boolean((await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tableName]
    ))?.found);
}

async function readLegacyAdminGrants(db, subjectId = null) {
    if (!await tableExists(db, 'clover_admin_roles')) return [];
    const rows = await db.all(
        'SELECT * FROM clover_admin_roles WHERE active = 1',
        subjectId ? [normalizeJid(subjectId)] : []
    );
    return rows.map((row) => ({
        subjectId: normalizeJid(row.player_id),
        roleKey: row.role,
        scopeType: 'global',
        scopeKey: '*',
        status: 'active',
        source: 'legacy_admin_roles',
    }));
}

async function readLegacyAccessGrants(db, subjectId = null) {
    if (!await tableExists(db, 'clover_access_roles')) return [];
    const rows = await db.all(
        "SELECT * FROM clover_access_roles WHERE status = 'active'",
        subjectId ? [normalizeJid(subjectId)] : []
    );
    return rows.map((row) => ({
        id: row.id,
        subjectId: normalizeJid(row.subject_id),
        roleKey: row.role_key,
        scopeType: row.scope_type,
        scopeKey: row.scope_key,
        status: 'active',
        source: 'legacy_access_roles',
    }));
}

function detectLegacyRoleConflicts(grants) {
    const admin = grants.filter((grant) => grant.source === 'legacy_admin_roles' && grant.scopeType === 'global');
    const access = grants.filter((grant) => grant.source === 'legacy_access_roles' && grant.scopeType === 'global');
    if (!admin.length || !access.length) return [];
    const adminRoles = [...new Set(admin.map((grant) => grant.roleKey))].sort();
    const accessRoles = [...new Set(access.map((grant) => grant.roleKey))].sort();
    return JSON.stringify(adminRoles) === JSON.stringify(accessRoles)
        ? []
        : [{ subjectId: admin[0].subjectId, adminRoles, accessRoles }];
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../groupAccess') return { isOwner: () => false, normalizeJid };
    if (request === './adminOperationContract') {
        return { getRoleCapabilities: (role) => definitions[role]?.permissions || [] };
    }
    if (request === './accessControlService') return { ROLE_DEFINITIONS: definitions };
    if (request === './canonicalRoleDefinitions') {
        return {
            permissionScopeMap(grants, owner = false) {
                const result = owner ? { '*': { global: true, squads: [] } } : {};
                for (const grant of grants) {
                    for (const permission of definitions[grant.roleKey]?.permissions || []) {
                        result[permission] ||= { global: false, squads: [] };
                        if (grant.scopeType === 'global') result[permission].global = true;
                        if (grant.scopeType === 'squad' && !result[permission].squads.includes(grant.scopeKey)) {
                            result[permission].squads.push(grant.scopeKey);
                        }
                    }
                }
                return result;
            },
        };
    }
    if (request === './canonicalRoleGrantSchema') {
        return {
            grantIdentity: (grant) => [grant.subjectId, grant.roleKey, grant.scopeType, grant.scopeKey].join('|'),
            isGrantActiveAt,
            rowToGrant,
        };
    }
    if (request === './canonicalRoleGrantLegacy') {
        return { detectLegacyRoleConflicts, readLegacyAccessGrants, readLegacyAdminGrants, tableExists };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const readers = require('../helpers/clover/canonicalRoleShadowReadOnly');
Module._load = originalLoad;

function fixtureDb(existingTables = ['clover_admin_roles', 'clover_access_roles', 'clover_role_grants']) {
    const writes = [];
    const tables = new Set(existingTables);
    return {
        writes,
        async exec(sql) {
            writes.push({ method: 'exec', sql });
            throw new Error('write attempted through exec');
        },
        async run(sql) {
            writes.push({ method: 'run', sql });
            throw new Error('write attempted through run');
        },
        async get(sql, params = []) {
            if (/sqlite_master/i.test(sql)) return tables.has(params[0]) ? { found: 1 } : undefined;
            throw new Error(`unexpected get: ${sql}`);
        },
        async all(sql, params = []) {
            if (/FROM clover_admin_roles/i.test(sql)) {
                return [{ player_id: params[0] || 'user@lid', role: 'evaluator', active: 1 }];
            }
            if (/FROM clover_access_roles/i.test(sql)) {
                if (/WHERE status = 'active'/i.test(sql)) {
                    return [{
                        id: 10,
                        subject_id: params[0] || 'user@lid',
                        role_key: 'evaluator',
                        scope_type: 'global',
                        scope_key: '*',
                        status: 'active',
                    }];
                }
                return [{ subject_id: 'user@lid' }, { subject_id: 'captain@lid' }];
            }
            if (/FROM clover_role_grants/i.test(sql)) {
                if (/WHERE status = 'active'/i.test(sql)) {
                    return [{
                        id: 20,
                        subject_id: params[0] || 'user@lid',
                        role_key: 'evaluator',
                        scope_type: 'global',
                        scope_key: '*',
                        status: 'active',
                        valid_from: '2026-01-01T00:00:00.000Z',
                        valid_until: null,
                    }];
                }
                return [{ subject_id: 'user@lid' }, { subject_id: 'helper@lid' }];
            }
            throw new Error(`unexpected all: ${sql}`);
        },
    };
}

test('todos os leitores funcionam com run e exec proibidos', async () => {
    const db = fixtureDb();
    const options = { ownerCheck: () => false, referenceDate: new Date('2026-07-31T00:00:00.000Z') };
    const admin = await readers.readLegacyAdminAccessReadOnly(db, 'user@lid', options);
    const access = await readers.readLegacyAccessContextReadOnly(db, 'user@lid', options);
    const canonicalGrants = await readers.readCanonicalGrantsReadOnly(db, {
        subjectId: 'user@lid', referenceDate: options.referenceDate,
    });
    const canonical = await readers.readCanonicalRoleContextReadOnly(db, 'user@lid', options);
    const subjects = await readers.listRoleShadowSubjectsReadOnly(db);

    assert.equal(admin.ok, true);
    assert.equal(admin.actor.role, 'evaluator');
    assert.equal(admin.actor.capabilities.includes('operation.view'), false);
    assert.equal(admin.actor.capabilities.includes('raid.reward.review'), true);
    assert.deepEqual(access.roleKeys, ['evaluator']);
    assert.equal(canonicalGrants.length, 1);
    assert.deepEqual(canonical.roleKeys, ['evaluator']);
    assert.equal(canonical.permissionScopes['character.read.profile'].global, true);
    assert.deepEqual(subjects, ['captain@lid', 'helper@lid', 'user@lid']);
    assert.deepEqual(db.writes, []);
});

test('tabelas ausentes retornam vazio sem CREATE TABLE nem UNION inválido', async () => {
    const db = fixtureDb([]);
    const options = { ownerCheck: () => false };
    assert.deepEqual(await readers.readCanonicalGrantsReadOnly(db), []);
    assert.equal((await readers.readLegacyAdminAccessReadOnly(db, 'user@lid', options)).ok, false);
    assert.deepEqual((await readers.readLegacyAccessContextReadOnly(db, 'user@lid', options)).assignments, []);
    assert.deepEqual(await readers.listRoleShadowSubjectsReadOnly(db), []);
    assert.deepEqual(db.writes, []);
});
