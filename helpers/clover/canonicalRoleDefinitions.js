'use strict';

const { normalizeSquadKey } = require('./cavalierService');

const CANONICAL_ROLE_KEYS = Object.freeze([
    'owner', 'admin', 'evaluator', 'narrator', 'assistant', 'captain', 'vice_captain',
]);

const CHARACTER_READ_PERMISSIONS = Object.freeze([
    'character.read.profile',
    'character.read.progress',
    'character.read.capacity',
    'character.read.grimoire',
]);

const SQUAD_READ_PERMISSIONS = Object.freeze([
    'squad.read.state',
    'squad.read.members',
    'squad.read.resources',
]);

const CANONICAL_ROLE_DEFINITIONS = Object.freeze({
    owner: Object.freeze({
        key: 'owner',
        label: 'Proprietário',
        scopeType: 'global',
        permissions: Object.freeze(['*']),
    }),
    admin: Object.freeze({
        key: 'admin',
        label: 'Administrador Geral',
        scopeType: 'global',
        permissions: Object.freeze([
            'operation.view',
            'operation.draft',
            'operation.simulate',
            'operation.apply',
            'operation.undo',
            'player.view',
            'player.manage',
            'player.identity.repair',
            'catalog.view',
            'catalog.manage.traits',
            'catalog.manage.items',
            'catalog.manage.hooks',
            'catalog.manage.rewards',
            'reward.grant',
            'resource.adjust',
            'integrity.view',
            ...CHARACTER_READ_PERMISSIONS,
            ...SQUAD_READ_PERMISSIONS,
            'squad.manage.members',
            'evaluation.apply',
            'raid.view',
            'raid.create',
            'raid.read.all',
            'raid.manage',
            'raid.reward.propose',
            'raid.reward.review',
        ]),
    }),
    evaluator: Object.freeze({
        key: 'evaluator',
        label: 'Avaliador',
        scopeType: 'global',
        permissions: Object.freeze([
            ...CHARACTER_READ_PERMISSIONS,
            'evaluation.apply',
            'raid.reward.review',
        ]),
    }),
    narrator: Object.freeze({
        key: 'narrator',
        label: 'Narrador',
        scopeType: 'global',
        permissions: Object.freeze([
            'operation.view',
            'operation.draft',
            'operation.simulate',
            'player.view',
            'catalog.view',
            'catalog.manage.hooks',
            ...CHARACTER_READ_PERMISSIONS,
            ...SQUAD_READ_PERMISSIONS,
            'raid.view',
            'raid.create',
            'raid.read.all',
            'raid.manage',
            'raid.reward.propose',
        ]),
    }),
    assistant: Object.freeze({
        key: 'assistant',
        label: 'Auxiliar',
        scopeType: 'global',
        permissions: Object.freeze([
            'operation.view',
            'operation.draft',
            'player.view',
            'catalog.view',
            'raid.view',
        ]),
    }),
    captain: Object.freeze({
        key: 'captain',
        label: 'Capitão',
        scopeType: 'squad',
        permissions: Object.freeze([
            ...CHARACTER_READ_PERMISSIONS,
            ...SQUAD_READ_PERMISSIONS,
            'squad.manage.members',
            'raid.view',
            'raid.create',
            'raid.manage',
            'raid.reward.propose',
        ]),
    }),
    vice_captain: Object.freeze({
        key: 'vice_captain',
        label: 'Vice-Capitão',
        scopeType: 'squad',
        permissions: Object.freeze([
            ...CHARACTER_READ_PERMISSIONS,
            ...SQUAD_READ_PERMISSIONS,
        ]),
    }),
});

const ROLE_ALIASES = Object.freeze({
    owner: 'owner',
    proprietario: 'owner',
    proprietaria: 'owner',
    admin: 'admin',
    adm: 'admin',
    administrador: 'admin',
    administradora: 'admin',
    evaluator: 'evaluator',
    avaliador: 'evaluator',
    avaliadora: 'evaluator',
    narrator: 'narrator',
    narrador: 'narrator',
    narradora: 'narrator',
    assistant: 'assistant',
    auxiliar: 'assistant',
    captain: 'captain',
    capitao: 'captain',
    capita: 'captain',
    vice: 'vice_captain',
    vicecaptain: 'vice_captain',
    vicecapitao: 'vice_captain',
    vicecapita: 'vice_captain',
    vice_captain: 'vice_captain',
});

class CanonicalRoleGrantError extends Error {
    constructor(message, code = 'canonical_role_grant_error', details = null) {
        super(message || code);
        this.name = 'CanonicalRoleGrantError';
        this.code = code;
        this.details = details;
    }
}

function normalizeRoleToken(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '');
}

function resolveCanonicalRoleKey(value) {
    const token = normalizeRoleToken(value);
    return ROLE_ALIASES[token] || (CANONICAL_ROLE_KEYS.includes(token) ? token : null);
}

function getCanonicalRoleDefinition(value) {
    const key = resolveCanonicalRoleKey(value);
    return key ? CANONICAL_ROLE_DEFINITIONS[key] : null;
}

function normalizeScope(roleDefinition, scopeKey) {
    if (!roleDefinition) throw new CanonicalRoleGrantError('Cargo desconhecido.', 'unknown_role');
    if (roleDefinition.scopeType === 'global') return { scopeType: 'global', scopeKey: '*' };
    const normalized = normalizeSquadKey(scopeKey);
    if (!normalized) {
        throw new CanonicalRoleGrantError(
            'O cargo exige um esquadrão válido.',
            'squad_scope_required',
            { role: roleDefinition.key }
        );
    }
    return { scopeType: 'squad', scopeKey: normalized };
}

function permissionScopeMap(grants, owner = false) {
    const map = new Map();
    if (owner) map.set('*', { global: true, squads: new Set() });
    for (const grant of grants || []) {
        const definition = CANONICAL_ROLE_DEFINITIONS[grant.roleKey];
        for (const permission of definition?.permissions || []) {
            if (!map.has(permission)) map.set(permission, { global: false, squads: new Set() });
            const target = map.get(permission);
            if (grant.scopeType === 'global') target.global = true;
            if (grant.scopeType === 'squad' && grant.scopeKey) target.squads.add(grant.scopeKey);
        }
    }
    return Object.fromEntries([...map.entries()].map(([permission, scope]) => [permission, {
        global: scope.global,
        squads: [...scope.squads].sort(),
    }]));
}

module.exports = {
    CANONICAL_ROLE_DEFINITIONS,
    CANONICAL_ROLE_KEYS,
    CHARACTER_READ_PERMISSIONS,
    SQUAD_READ_PERMISSIONS,
    CanonicalRoleGrantError,
    getCanonicalRoleDefinition,
    normalizeRoleToken,
    normalizeScope,
    permissionScopeMap,
    resolveCanonicalRoleKey,
};
