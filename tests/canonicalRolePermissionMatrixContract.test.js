'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
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
    CANONICAL_ROLE_DEFINITIONS,
    CHARACTER_READ_PERMISSIONS,
    getCanonicalRoleDefinition,
    permissionScopeMap,
    resolveCanonicalRoleKey,
} = require('../helpers/clover/canonicalRoleDefinitions');
Module._load = originalLoad;

const permissions = (role) => new Set(CANONICAL_ROLE_DEFINITIONS[role].permissions);

function assertIncludes(role, expected) {
    const actual = permissions(role);
    for (const permission of expected) {
        assert.equal(actual.has(permission), true, `${role} deveria possuir ${permission}`);
    }
}

function assertExcludes(role, expected) {
    const actual = permissions(role);
    for (const permission of expected) {
        assert.equal(actual.has(permission), false, `${role} não deveria possuir ${permission}`);
    }
}

test('somente Proprietário recebe wildcard', () => {
    assert.deepEqual(CANONICAL_ROLE_DEFINITIONS.owner.permissions, ['*']);
    for (const role of ['admin', 'evaluator', 'narrator', 'assistant', 'captain', 'vice_captain']) {
        assert.equal(permissions(role).has('*'), false, `${role} não pode receber wildcard`);
    }
});

test('Administrador Geral possui matriz explícita sem herdar autoridade do Owner', () => {
    assertIncludes('admin', [
        'operation.apply',
        'operation.undo',
        'player.identity.repair',
        'catalog.manage.items',
        'reward.grant',
        'resource.adjust',
        'integrity.view',
        'evaluation.apply',
        'raid.reward.propose',
        'raid.reward.review',
    ]);
    assert.equal(permissions('admin').has('role.grant.owner'), false);
});

test('Avaliador permanece especializado e não ganha gestão geral', () => {
    assertIncludes('evaluator', [
        'operation.view',
        'operation.draft',
        'operation.simulate',
        'player.view',
        'catalog.view',
        ...CHARACTER_READ_PERMISSIONS,
        'evaluation.apply',
        'raid.reward.review',
    ]);
    assertExcludes('evaluator', [
        'operation.apply',
        'operation.undo',
        'player.manage',
        'catalog.manage.traits',
        'catalog.manage.hooks',
        'catalog.manage.rewards',
        'raid.manage',
        'raid.reward.propose',
    ]);
});

test('Narrador pode gerir raids e propor recompensa, mas não aprová-la', () => {
    assertIncludes('narrator', [
        'catalog.manage.hooks',
        'raid.view',
        'raid.create',
        'raid.read.all',
        'raid.manage',
        'raid.reward.propose',
    ]);
    assertExcludes('narrator', [
        'evaluation.apply',
        'raid.reward.review',
        'catalog.manage.rewards',
        'reward.grant',
    ]);
});

test('Auxiliar mantém acesso operacional mínimo sem leituras profundas do personagem', () => {
    assert.deepEqual(CANONICAL_ROLE_DEFINITIONS.assistant.permissions, [
        'operation.view',
        'operation.draft',
        'player.view',
        'catalog.view',
        'raid.view',
    ]);
    assertExcludes('assistant', CHARACTER_READ_PERMISSIONS);
});

test('Capitão propõe no próprio esquadrão e Vice-Capitão permanece somente leitura', () => {
    assertIncludes('captain', [
        'squad.manage.members',
        'raid.view',
        'raid.create',
        'raid.manage',
        'raid.reward.propose',
    ]);
    assertExcludes('captain', ['raid.reward.review', 'evaluation.apply']);
    assertExcludes('vice_captain', [
        'squad.manage.members',
        'raid.create',
        'raid.manage',
        'raid.reward.propose',
        'raid.reward.review',
    ]);

    const scoped = permissionScopeMap([{
        roleKey: 'captain',
        scopeType: 'squad',
        scopeKey: 'trevos_da_esperanca',
    }]);
    assert.deepEqual(scoped['raid.reward.propose'], {
        global: false,
        squads: ['trevos_da_esperanca'],
    });
});

test('aliases preservam gênero e nomenclatura administrativa', () => {
    assert.equal(resolveCanonicalRoleKey('Proprietária'), 'owner');
    assert.equal(resolveCanonicalRoleKey('Administradora'), 'admin');
    assert.equal(resolveCanonicalRoleKey('Avaliadora'), 'evaluator');
    assert.equal(resolveCanonicalRoleKey('Narradora'), 'narrator');
    assert.equal(resolveCanonicalRoleKey('Vice-Capitã'), 'vice_captain');
    assert.equal(getCanonicalRoleDefinition('Administrador').label, 'Administrador Geral');
});
