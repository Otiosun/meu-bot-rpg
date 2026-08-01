'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let scenario = null;

const CHARACTER_READ = [
    'character.read.profile',
    'character.read.progress',
    'character.read.capacity',
    'character.read.grimoire',
];

const rolePermissions = {
    admin: [
        'operation.apply', 'operation.undo', 'player.manage', 'player.identity.repair',
        'squad.manage.members', 'raid.manage', 'raid.reward.propose', 'raid.reward.review',
    ],
    evaluator: [...CHARACTER_READ, 'evaluation.apply', 'raid.reward.review'],
    narrator: [
        'operation.view', 'operation.draft', 'operation.simulate',
        'player.view', 'catalog.view', 'catalog.manage.hooks',
        ...CHARACTER_READ,
        'squad.read.state', 'squad.read.members', 'squad.read.resources',
        'raid.view', 'raid.create', 'raid.read.all', 'raid.manage', 'raid.reward.propose',
    ],
    assistant: ['operation.view', 'operation.draft', 'player.view', 'catalog.view', 'raid.view'],
    captain: [
        ...CHARACTER_READ,
        'squad.read.state', 'squad.read.members', 'squad.read.resources',
        'squad.manage.members', 'raid.view', 'raid.create', 'raid.manage', 'raid.reward.propose',
    ],
    vice_captain: [
        ...CHARACTER_READ,
        'squad.read.state', 'squad.read.members', 'squad.read.resources',
    ],
};

const legacyRolePermissions = {
    admin: ['*'],
    evaluator: rolePermissions.evaluator,
    narrator: rolePermissions.narrator.filter((permission) => permission !== 'raid.reward.propose'),
    assistant: rolePermissions.assistant,
    captain: rolePermissions.captain.filter((permission) => permission !== 'raid.reward.propose'),
    vice_captain: rolePermissions.vice_captain,
};

const canonicalDefinitions = Object.fromEntries(Object.entries(rolePermissions)
    .map(([key, permissions]) => [key, { permissions }]));
canonicalDefinitions.owner = { permissions: ['*'] };

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
    if (request === './canonicalRoleDefinitions') {
        return { CANONICAL_ROLE_DEFINITIONS: canonicalDefinitions };
    }
    if (request === './canonicalRoleShadowReadOnly') {
        return {
            readLegacyAdminAccessReadOnly: async () => scenario.adminAccess,
            readLegacyAccessContextReadOnly: async () => scenario.accessContext,
            readCanonicalRoleContextReadOnly: async () => scenario.canonicalContext,
            listRoleShadowSubjectsReadOnly: async () => scenario.subjects || [],
            legacyRoleGrantsPermission(role, permission) {
                return legacyRolePermissions[role]?.includes('*')
                    || legacyRolePermissions[role]?.includes(permission)
                    || false;
            },
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const shadow = require('../helpers/clover/canonicalRoleShadowService');
Module._load = originalLoad;

function globalPermissionScopes(permissions) {
    return Object.fromEntries(permissions.map((permission) => [permission, { global: true, squads: [] }]));
}

function baseScenario() {
    const permissions = rolePermissions.evaluator;
    return {
        adminAccess: {
            ok: true,
            actor: {
                role: 'evaluator',
                capabilities: permissions,
                source: 'legacy_admin_roles',
            },
        },
        accessContext: {
            owner: false,
            roleKeys: ['evaluator'],
            permissions,
            squadScopes: [],
            assignments: [{ role_key: 'evaluator', scope_type: 'global', scope_key: '*' }],
        },
        canonicalContext: {
            owner: false,
            roleKeys: ['evaluator'],
            observedRoleKeys: ['evaluator'],
            permissionScopes: globalPermissionScopes(permissions),
            conflicts: [],
            blockedByConflict: false,
            sources: ['canonical'],
        },
        subjects: ['a@lid', 'b@lid'],
    };
}

test('contextos equivalentes usam a autoridade legada efetiva e produzem relatório limpo', async () => {
    scenario = baseScenario();
    const report = await shadow.buildCanonicalRoleShadowReport({}, 'User@LID', {
        probes: ['character.read.profile', 'evaluation.apply', 'raid.reward.review'],
    });
    assert.equal(report.subjectId, 'user@lid');
    assert.equal(report.write, false);
    assert.equal(report.queryOnlySafe, true);
    assert.equal(report.roles.divergent, false);
    assert.equal(report.summary.divergentDecisionCount, 0);
    assert.equal(report.summary.legacyEffectiveDivergenceCount, 0);
    assert.equal(report.summary.approvedPolicyExpansionCount, 0);
    assert.equal(report.summary.unapprovedCanonicalExpansionCount, 0);
    assert.equal(report.summary.canonicalRegressionCount, 0);
    assert.equal(report.summary.critical, false);
});

test('Avaliador não recebe operação geral nem proposta de recompensa', async () => {
    scenario = baseScenario();
    const report = await shadow.buildCanonicalRoleShadowReport({}, 'user@lid', {
        probes: ['operation.view', 'player.manage', 'raid.reward.propose', 'raid.reward.review'],
    });
    assert.equal(report.decisions.find((item) => item.permission === 'operation.view').canonical, false);
    assert.equal(report.decisions.find((item) => item.permission === 'player.manage').canonical, false);
    assert.equal(report.decisions.find((item) => item.permission === 'raid.reward.propose').canonical, false);
    assert.equal(report.decisions.find((item) => item.permission === 'raid.reward.review').canonical, true);
    assert.equal(report.summary.critical, false);
});

test('conflito entre Avaliador e Narrador é visível e fail-closed', async () => {
    scenario = baseScenario();
    scenario.accessContext.roleKeys = ['narrator'];
    scenario.accessContext.permissions = legacyRolePermissions.narrator;
    scenario.accessContext.assignments = [{ role_key: 'narrator', scope_type: 'global', scope_key: '*' }];
    scenario.canonicalContext = {
        owner: false,
        roleKeys: [],
        observedRoleKeys: ['evaluator', 'narrator'],
        permissionScopes: {},
        conflicts: [{ subjectId: 'user@lid', roles: ['evaluator', 'narrator'] }],
        blockedByConflict: true,
        sources: ['legacy_admin_roles', 'legacy_access_roles'],
    };
    const report = await shadow.buildCanonicalRoleShadowReport({}, 'user@lid', {
        probes: ['raid.reward.review', 'raid.manage'],
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
        permissions: legacyRolePermissions.captain,
        squadScopes: ['lobos'],
        assignments: [{ role_key: 'captain', scope_type: 'squad', scope_key: 'lobos' }],
    };
    scenario.canonicalContext = {
        owner: false,
        roleKeys: ['captain'],
        observedRoleKeys: ['captain'],
        permissionScopes: {
            'squad.manage.members': { global: false, squads: ['lobos'] },
            'raid.manage': { global: false, squads: ['lobos'] },
            'raid.reward.propose': { global: false, squads: ['lobos'] },
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
    assert.equal(report.decisions[0].legacyEffective, true);
    assert.equal(report.decisions[1].legacyAccessGeneric, true);
    assert.equal(report.decisions[1].legacyAccessScoped, false);
    assert.equal(report.decisions[1].canonical, false);
    assert.equal(report.decisions[1].classifications.includes('legacy_scope_leak'), true);
    assert.equal(report.summary.scopeLeakCount, 1);
    assert.equal(report.summary.critical, true);
});

test('Auxiliar da Central não é crítico quando a fonte operacional está vazia', async () => {
    scenario = baseScenario();
    scenario.adminAccess = {
        ok: true,
        actor: { role: 'assistant', capabilities: rolePermissions.assistant, source: 'legacy_admin_roles' },
    };
    scenario.accessContext = {
        owner: false, roleKeys: [], permissions: [], squadScopes: [], assignments: [],
    };
    scenario.canonicalContext = {
        owner: false,
        roleKeys: ['assistant'],
        observedRoleKeys: ['assistant'],
        permissionScopes: globalPermissionScopes(rolePermissions.assistant),
        conflicts: [], blockedByConflict: false, sources: ['canonical'],
    };
    const report = await shadow.buildCanonicalRoleShadowReport({}, 'helper@lid', {
        probes: ['operation.view', 'player.view', 'character.read.profile'],
    });
    assert.equal(report.legacy.admin.role, 'assistant');
    assert.deepEqual(report.canonical.roleKeys, ['assistant']);
    assert.equal(report.decisions.find((item) => item.permission === 'operation.view').legacyEffective, true);
    assert.equal(report.decisions.find((item) => item.permission === 'operation.view').canonical, true);
    assert.equal(report.decisions.find((item) => item.permission === 'character.read.profile').canonical, false);
    assert.equal(report.summary.legacyEffectiveDivergenceCount, 0);
    assert.equal(report.summary.critical, false);
});

test('expansão explícita do Administrador é registrada e não tratada como corrupção', async () => {
    scenario = baseScenario();
    scenario.adminAccess = {
        ok: true,
        actor: { role: 'admin', capabilities: ['operation.apply'], source: 'legacy_admin_roles' },
    };
    scenario.accessContext = {
        owner: false, roleKeys: [], permissions: [], squadScopes: [], assignments: [],
    };
    scenario.canonicalContext = {
        owner: false,
        roleKeys: ['admin'],
        observedRoleKeys: ['admin'],
        permissionScopes: globalPermissionScopes(['operation.apply', 'player.identity.repair']),
        conflicts: [], blockedByConflict: false, sources: ['canonical'],
    };
    const report = await shadow.buildCanonicalRoleShadowReport({}, 'admin@lid', {
        probes: ['operation.apply', 'player.identity.repair'],
    });
    const expansion = report.decisions.find((item) => item.permission === 'player.identity.repair');
    assert.equal(expansion.legacyEffective, false);
    assert.equal(expansion.canonical, true);
    assert.equal(expansion.policyDeltaApproved, true);
    assert.equal(expansion.policyDeltaReason, 'approved_admin_explicit_matrix');
    assert.equal(expansion.classifications.includes('approved_policy_expansion'), true);
    assert.equal(report.summary.approvedPolicyExpansionCount, 1);
    assert.equal(report.summary.unapprovedCanonicalExpansionCount, 0);
    assert.equal(report.summary.critical, false);
});

test('proposta de recompensa do Capitão é delta aprovado apenas no próprio escopo', async () => {
    scenario = baseScenario();
    scenario.adminAccess = { ok: false };
    scenario.accessContext = {
        owner: false,
        roleKeys: ['captain'],
        permissions: legacyRolePermissions.captain,
        squadScopes: ['trevos'],
        assignments: [{ role_key: 'captain', scope_type: 'squad', scope_key: 'trevos' }],
    };
    scenario.canonicalContext = {
        owner: false,
        roleKeys: ['captain'],
        observedRoleKeys: ['captain'],
        permissionScopes: {
            'raid.reward.propose': { global: false, squads: ['trevos'] },
        },
        conflicts: [], blockedByConflict: false, sources: ['canonical'],
    };
    const report = await shadow.buildCanonicalRoleShadowReport({}, 'captain@lid', {
        probes: [{ permission: 'raid.reward.propose', scopeKey: 'trevos' }],
    });
    const decision = report.decisions[0];
    assert.equal(decision.legacyEffective, false);
    assert.equal(decision.canonical, true);
    assert.equal(decision.policyDeltaApproved, true);
    assert.equal(decision.policyDeltaReason, 'approved_captain_reward_proposal');
    assert.equal(report.summary.approvedPolicyExpansionCount, 1);
    assert.equal(report.summary.critical, false);
});

test('expansão fora da matriz aprovada continua crítica', async () => {
    scenario = baseScenario();
    scenario.canonicalContext.permissionScopes['player.manage'] = { global: true, squads: [] };
    const report = await shadow.buildCanonicalRoleShadowReport({}, 'evaluator@lid', {
        probes: ['player.manage'],
    });
    const decision = report.decisions[0];
    assert.equal(decision.legacyEffective, false);
    assert.equal(decision.canonical, true);
    assert.equal(decision.policyDeltaApproved, false);
    assert.equal(decision.classifications.includes('unapproved_canonical_expansion'), true);
    assert.equal(report.summary.unapprovedCanonicalExpansionCount, 1);
    assert.equal(report.summary.critical, true);
});

test('regressão canônica de acesso existente continua crítica', async () => {
    scenario = baseScenario();
    delete scenario.canonicalContext.permissionScopes['evaluation.apply'];
    const report = await shadow.buildCanonicalRoleShadowReport({}, 'evaluator@lid', {
        probes: ['evaluation.apply'],
    });
    const decision = report.decisions[0];
    assert.equal(decision.legacyEffective, true);
    assert.equal(decision.canonical, false);
    assert.equal(decision.classifications.includes('canonical_regression'), true);
    assert.equal(report.summary.canonicalRegressionCount, 1);
    assert.equal(report.summary.critical, true);
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
    assert.equal(report.decisions.every((decision) => decision.legacyEffective), true);
    assert.equal(report.summary.critical, false);
});

test('batch agrega deltas e deduplica sujeitos sem declarar escrita', async () => {
    scenario = baseScenario();
    scenario.subjects = ['a@lid', 'b@lid', 'a@lid'];
    const batch = await shadow.buildCanonicalRoleShadowBatch({}, {
        subjectIds: ['A@lid', 'a@lid'],
        probes: ['character.read.profile'],
    });
    assert.equal(batch.write, false);
    assert.equal(batch.queryOnlySafe, true);
    assert.equal(batch.subjectCount, 1);
    assert.equal(batch.reports[0].write, false);
    assert.equal(batch.unapprovedCanonicalExpansionCount, 0);
    assert.equal(batch.canonicalRegressionCount, 0);
});
