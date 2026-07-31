'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let scenario = null;

const rolePermissions = {
    admin: ['*'],
    evaluator: ['operation.view', 'evaluation.apply', 'raid.reward.review'],
    narrator: ['operation.view', 'raid.manage', 'squad.read.members'],
    assistant: ['operation.view', 'player.view'],
    captain: ['squad.read.members', 'squad.manage.members', 'raid.manage'],
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../groupAccess') {
        return { normalizeJid: (value) => String(value || '').trim().toLowerCase() };
    }
    if (request === './cavalierService') {
        return {
            normalizeSquadKey: (value) => String(value || '')
                .trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || null,
        };
    }
    if (request === './adminAccessService') {
        return { getAdminActorAccess: async () => scenario.adminAccess };
    }
    if (request === './accessControlService') {
        return {
            getAccessContext: async () => scenario.accessContext,
            contextHasPermission(context, permission) {
                return context.owner || context.permissions.includes('*') || context.permissions.includes(permission);
            },
            roleGrantsPermission(role, permission) {
                return rolePermissions[role]?.includes('*') || rolePermissions[role]?.includes(permission) || false;
            },
        };
    }
    if (request === './canonicalRoleGrantService') {
        return {
            CANONICAL_ROLE_DEFINITIONS: {
                owner: { permissions: ['*'] },
                admin: { permissions: ['*'] },
                evaluator: { permissions: rolePermissions.evaluator },
                narrator: { permissions: rolePermissions.narrator },
                assistant: { permissions: rolePermissions.assistant },
                captain: { permissions: rolePermissions.captain },
            },
            getCanonicalRoleContext: async () => scenario.canonicalContext,
            contextHasCanonicalPermission(context, permission, scopeKey) {
                if (context.owner || context.permissionScopes['*']?.global) return true;
                const scope = context.permissionScopes[permission];
                return Boolean(scope?.global || (scopeKey && scope?.squads.includes(scopeKey)));
            },
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const shadow = require('../helpers/clover/canonicalRoleShadowService');
Module._load = originalLoad;

function baseScenario() {
    return {
        adminAccess: {
            ok: true,
            actor: {
                role: 'evaluator',
                capabilities: ['operation.view', 'evaluation.apply', 'raid.reward.review'],
                source: 'admin_role',
            },
        },
        accessContext: {
            owner: false,
            roleKeys: ['evaluator'],
            permissions: ['operation.view', 'evaluation.apply', 'raid.reward.review'],
            squadScopes: [],
            assignments: [{ role_key: 'evaluator', scope_type: 'global', scope_key: '*' }],
        },
        canonicalContext: {
            owner: false,
            roleKeys: ['evaluator'],
            observedRoleKeys: ['evaluator'],
            permissionScopes: {
                'operation.view': { global: true, squads: [] },
                'evaluation.apply': { global: true, squads: [] },
                'raid.reward.review': { global: true, squads: [] },
            },
            conflicts: [],
            blockedByConflict: false,
            sources: ['canonical'],
        },
    };
}

test('contextos equivalentes produzem relatório limpo e read-only', async () => {
    scenario = baseScenario();
    const report = await shadow.buildCanonicalRoleShadowReport({}, 'User@LID', {
        probes: ['operation.view', 'evaluation.apply'],
    });
    assert.equal(report.subjectId, 'user@lid');
    assert.equal(report.write, false);
    assert.equal(report.roles.divergent, false);
    assert.equal(report.summary.divergentDecisionCount, 0);
    assert.equal(report.summary.critical, false);
});

test('conflito de cargos globais é visível e fail-closed', async () => {
    scenario = baseScenario();
    scenario.adminAccess.actor.role = 'evaluator';
    scenario.accessContext.roleKeys = ['narrator'];
    scenario.accessContext.permissions = ['operation.view', 'raid.manage'];
    scenario.accessContext.assignments = [{ role_key: 'narrator', scope_type: 'global', scope_key: '*' }];
    scenario.canonicalContext = {
        owner: false,
        roleKeys: [],
        observedRoleKeys: ['evaluator', 'narrator'],
        permissionScopes: {},
        conflicts: [{ subjectId: 'user@lid', roles: ['evaluator', 'narrator'] }],
        blockedByConflict: true,
        sources: ['legacy_admin', 'legacy_access'],
    };
    const report = await shadow.buildCanonicalRoleShadowReport({}, 'user@lid', {
        probes: ['operation.view', 'raid.manage'],
    });
    assert.equal(report.roles.divergent, true);
    assert.equal(report.canonical.blockedByConflict, true);
    assert.equal(report.summary.canonicalConflictCount, 1);
    assert.equal(report.summary.critical, true);
});

test('Capitão genérico revela vazamento de escopo fora do esquadrão', async () => {
    scenario = baseScenario();
    scenario.adminAccess = { ok: false };
    scenario.accessContext = {
        owner: false,
        roleKeys: ['captain'],
        permissions: ['squad.read.members', 'squad.manage.members', 'raid.manage'],
        squadScopes: ['lobos'],
        assignments: [{ role_key: 'captain', scope_type: 'squad', scope_key: 'lobos' }],
    };
    scenario.canonicalContext = {
        owner: false,
        roleKeys: ['captain'],
        observedRoleKeys: ['captain'],
        permissionScopes: {
            'squad.read.members': { global: false, squads: ['lobos'] },
            'squad.manage.members': { global: false, squads: ['lobos'] },
            'raid.manage': { global: false, squads: ['lobos'] },
        },
        conflicts: [], blockedByConflict: false, sources: ['canonical'],
    };
    const report = await shadow.buildCanonicalRoleShadowReport({}, 'captain@lid', {
        probes: [
            { permission: 'squad.manage.members', scopeKey: 'lobos' },
            { permission: 'squad.manage.members', scopeKey: 'trevos' },
        ],
    });
    assert.equal(report.decisions[0].canonical, true);
    assert.equal(report.decisions[0].legacyAccessScoped, true);
    assert.equal(report.decisions[1].legacyAccessGeneric, true);
    assert.equal(report.decisions[1].legacyAccessScoped, false);
    assert.equal(report.decisions[1].canonical, false);
    assert.equal(report.decisions[1].classifications.includes('legacy_scope_leak'), true);
    assert.equal(report.summary.scopeLeakCount, 1);
    assert.equal(report.summary.critical, true);
});

test('Auxiliar legado da Central é preservado pela matriz canônica', async () => {
    scenario = baseScenario();
    scenario.adminAccess = {
        ok: true,
        actor: { role: 'assistant', capabilities: ['operation.view', 'player.view'], source: 'admin_role' },
    };
    scenario.accessContext = {
        owner: false, roleKeys: [], permissions: [], squadScopes: [], assignments: [],
    };
    scenario.canonicalContext = {
        owner: false,
        roleKeys: ['assistant'],
        observedRoleKeys: ['assistant'],
        permissionScopes: {
            'operation.view': { global: true, squads: [] },
            'player.view': { global: true, squads: [] },
        },
        conflicts: [], blockedByConflict: false, sources: ['canonical'],
    };
    const report = await shadow.buildCanonicalRoleShadowReport({}, 'helper@lid', {
        probes: ['operation.view', 'player.view'],
    });
    assert.equal(report.legacy.admin.role, 'assistant');
    assert.deepEqual(report.canonical.roleKeys, ['assistant']);
    assert.equal(report.decisions.every((decision) => decision.canonical), true);
    assert.equal(report.summary.scopeLeakCount, 0);
});

test('Owner permanece consistente sem depender das tabelas', async () => {
    scenario = baseScenario();
    scenario.adminAccess = { ok: true, actor: { role: 'owner', capabilities: ['*'], source: 'owner_config' } };
    scenario.accessContext = { owner: true, roleKeys: [], permissions: ['*'], squadScopes: [], assignments: [] };
    scenario.canonicalContext = {
        owner: true, roleKeys: ['owner'], observedRoleKeys: ['owner'],
        permissionScopes: { '*': { global: true, squads: [] } },
        conflicts: [], blockedByConflict: false, sources: ['owner_config'],
    };
    const report = await shadow.buildCanonicalRoleShadowReport({}, 'owner@lid', {
        probes: ['operation.apply', { permission: 'squad.manage.members', scopeKey: 'lobos' }],
    });
    assert.equal(report.decisions.every((decision) => decision.canonical), true);
    assert.equal(report.decisions.every((decision) => decision.legacyAccessScoped), true);
    assert.equal(report.summary.critical, false);
});

test('batch lista sujeitos das três fontes sem duplicação e nunca escreve', async () => {
    scenario = baseScenario();
    const db = {
        async all(sql) {
            assert.match(sql, /clover_admin_roles/);
            assert.match(sql, /clover_access_roles/);
            assert.match(sql, /clover_role_grants/);
            return [
                { subject_id: 'a@lid' },
                { subject_id: 'b@lid' },
                { subject_id: 'a@lid' },
            ];
        },
    };
    const subjects = await shadow.listRoleShadowSubjects(db);
    assert.deepEqual(subjects, ['a@lid', 'b@lid']);
    const batch = await shadow.buildCanonicalRoleShadowBatch(db, {
        subjectIds: ['A@lid', 'a@lid'],
        probes: ['operation.view'],
    });
    assert.equal(batch.write, false);
    assert.equal(batch.subjectCount, 1);
    assert.equal(batch.reports[0].write, false);
});
