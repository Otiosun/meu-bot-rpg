'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../groupAccess') {
        return {
            isOwner: (value) => String(value || '') === 'owner@lid',
            normalizeJid: (value) => String(value || '').trim().toLowerCase(),
        };
    }
    if (request === './cavalierService') {
        return {
            normalizeSquadKey: (value) => String(value || '')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, ''),
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const {
    contextHasCanonicalPermission,
    detectLegacyRoleConflicts,
    getCanonicalRoleContext,
    getCanonicalRoleDefinition,
    grantCanonicalRole,
    revokeCanonicalRole,
    isGrantActiveAt,
    normalizeScope,
    planLegacyRoleMigration,
    resolveCanonicalRoleKey,
} = require('../helpers/clover/canonicalRoleGrantService');
Module._load = originalLoad;

class FakeDb {
    constructor({ canonical = [], admin = [], access = [], tables = {} } = {}) {
        this.canonical = canonical;
        this.admin = admin;
        this.access = access;
        this.tables = {
            clover_admin_roles: admin.length > 0,
            clover_access_roles: access.length > 0,
            ...tables,
        };
        this.execs = [];
    }

    async exec(sql) {
        this.execs.push(sql);
    }

    async get(sql, params = []) {
        if (sql.includes('sqlite_master')) {
            return this.tables[params[0]] ? { found: 1 } : null;
        }
        return null;
    }

    async all(sql, params = []) {
        if (sql.includes('FROM clover_role_grants')) {
            const subject = sql.includes('subject_id = ?') ? params[0] : null;
            return this.canonical.filter((row) => !subject || row.subject_id === subject);
        }
        if (sql.includes('FROM clover_admin_roles')) {
            const subject = sql.includes('player_id = ?') ? params[0] : null;
            return this.admin.filter((row) => !subject || row.player_id === subject);
        }
        if (sql.includes('FROM clover_access_roles')) {
            const subject = sql.includes('subject_id = ?') ? params[0] : null;
            return this.access.filter((row) => !subject || row.subject_id === subject);
        }
        return [];
    }
}

function canonicalGrant(overrides = {}) {
    return {
        id: 1,
        subject_id: 'captain@lid',
        role_key: 'captain',
        scope_type: 'squad',
        scope_key: 'lobos_cinzentos',
        status: 'active',
        valid_from: '2026-01-01T00:00:00.000Z',
        valid_until: null,
        granted_by: 'admin@lid',
        grant_reason: 'Mandato',
        origin_type: 'captain_mandate',
        origin_ref: 'mandate:1',
        metadata_json: '{}',
        created_at: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

test('papéis canônicos incluem Auxiliar e preservam escopo exigido', () => {
    assert.equal(resolveCanonicalRoleKey('Auxiliar'), 'assistant');
    assert.equal(getCanonicalRoleDefinition('Administrador').label, 'Administrador Geral');
    assert.deepEqual(normalizeScope(getCanonicalRoleDefinition('narrator'), 'qualquer'), {
        scopeType: 'global',
        scopeKey: '*',
    });
    assert.deepEqual(normalizeScope(getCanonicalRoleDefinition('captain'), 'Lobos Cinzentos'), {
        scopeType: 'squad',
        scopeKey: 'lobos_cinzentos',
    });
    assert.throws(
        () => normalizeScope(getCanonicalRoleDefinition('captain'), ''),
        (error) => error?.code === 'squad_scope_required'
    );
});

test('owner recebe wildcard global sem depender de tabela', async () => {
    const context = await getCanonicalRoleContext(new FakeDb(), 'owner@lid');
    assert.equal(context.owner, true);
    assert.deepEqual(context.roleKeys, ['owner']);
    assert.equal(contextHasCanonicalPermission(context, 'qualquer.permissao'), true);
});

test('capitão não vaza permissão para outro esquadrão', async () => {
    const db = new FakeDb({ canonical: [canonicalGrant()] });
    const context = await getCanonicalRoleContext(db, 'captain@lid', { includeLegacy: false });
    assert.equal(contextHasCanonicalPermission(context, 'squad.manage.members', 'Lobos Cinzentos'), true);
    assert.equal(contextHasCanonicalPermission(context, 'squad.manage.members', 'Coringas Magenta'), false);
    assert.deepEqual(context.permissionScopes['squad.manage.members'], {
        global: false,
        squads: ['lobos_cinzentos'],
    });
});

test('concessão canônica prevalece sobre duplicata legada idêntica', async () => {
    const db = new FakeDb({
        canonical: [canonicalGrant()],
        access: [{
            id: 9,
            subject_id: 'captain@lid',
            role_key: 'captain',
            scope_type: 'squad',
            scope_key: 'lobos_cinzentos',
            status: 'active',
            assigned_by: 'legacy@lid',
            created_at: '2025-01-01T00:00:00.000Z',
            metadata_json: '{}',
        }],
    });
    const context = await getCanonicalRoleContext(db, 'captain@lid');
    assert.equal(context.grants.length, 1);
    assert.equal(context.grants[0].source, 'canonical');
});

test('divergência entre cargos globais legados fica explícita', async () => {
    const admin = [{
        player_id: 'staff@lid',
        role: 'evaluator',
        granted_by: 'owner@lid',
        granted_at: '2026-01-01T00:00:00.000Z',
    }];
    const access = [{
        id: 3,
        subject_id: 'staff@lid',
        role_key: 'narrator',
        scope_type: 'global',
        scope_key: '*',
        status: 'active',
        assigned_by: 'owner@lid',
        created_at: '2026-01-02T00:00:00.000Z',
    }];
    const db = new FakeDb({ admin, access });
    const context = await getCanonicalRoleContext(db, 'staff@lid');
    assert.deepEqual(context.observedRoleKeys.sort(), ['evaluator', 'narrator']);
    assert.deepEqual(context.roleKeys, []);
    assert.equal(context.blockedByConflict, true);
    assert.equal(contextHasCanonicalPermission(context, 'raid.reward.review'), false);
    assert.equal(contextHasCanonicalPermission(context, 'raid.manage'), false);
    assert.deepEqual(context.conflicts, [{
        code: 'legacy_global_role_divergence',
        subjectId: 'staff@lid',
        adminRoles: ['evaluator'],
        accessRoles: ['narrator'],
    }]);
    assert.deepEqual(detectLegacyRoleConflicts(context.grants.filter((grant) => grant.source.startsWith('legacy_'))), context.conflicts);
});

test('planejador é somente leitura, deduplica e inclui Auxiliar legado', async () => {
    const db = new FakeDb({
        canonical: [canonicalGrant()],
        admin: [{
            player_id: 'helper@lid',
            role: 'assistant',
            granted_by: 'owner@lid',
            granted_at: '2026-01-01T00:00:00.000Z',
        }],
        access: [{
            id: 9,
            subject_id: 'captain@lid',
            role_key: 'captain',
            scope_type: 'squad',
            scope_key: 'lobos_cinzentos',
            status: 'active',
            assigned_by: 'owner@lid',
            created_at: '2026-01-01T00:00:00.000Z',
        }],
    });
    const plan = await planLegacyRoleMigration(db);
    assert.equal(plan.write, false);
    assert.equal(plan.plannedCount, 1);
    assert.equal(plan.planned[0].subjectId, 'helper@lid');
    assert.equal(plan.planned[0].roleKey, 'assistant');
});

test('concessões futuras ou expiradas não são ativas', () => {
    const reference = new Date('2026-07-31T00:00:00.000Z');
    assert.equal(isGrantActiveAt({
        status: 'active',
        validFrom: '2026-08-01T00:00:00.000Z',
        validUntil: null,
    }, reference), false);
    assert.equal(isGrantActiveAt({
        status: 'active',
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: '2026-07-30T00:00:00.000Z',
    }, reference), false);
    assert.equal(isGrantActiveAt({
        status: 'active',
        validFrom: '2026-01-01T00:00:00.000Z',
        validUntil: '2026-08-30T00:00:00.000Z',
    }, reference), true);
});

test('owner não pode ser concedido ou revogado manualmente', async () => {
    const db = new FakeDb();
    await assert.rejects(
        () => grantCanonicalRole(db, {
            subjectId: 'other@lid',
            role: 'owner',
            grantedBy: 'owner@lid',
        }),
        (error) => error?.code === 'owner_role_not_assignable'
    );
    await assert.rejects(
        () => revokeCanonicalRole(db, {
            subjectId: 'owner@lid',
            role: 'owner',
            revokedBy: 'owner@lid',
        }),
        (error) => error?.code === 'owner_role_not_revocable'
    );
});

test('validade invertida é rejeitada antes de qualquer escrita', async () => {
    const db = new FakeDb();
    await assert.rejects(
        () => grantCanonicalRole(db, {
            subjectId: 'staff@lid',
            role: 'evaluator',
            grantedBy: 'owner@lid',
            validFrom: '2026-08-10T00:00:00.000Z',
            validUntil: '2026-08-01T00:00:00.000Z',
        }),
        (error) => error?.code === 'invalid_grant_validity'
    );
    assert.equal(db.execs.some((sql) => sql === 'BEGIN IMMEDIATE'), false);
});
