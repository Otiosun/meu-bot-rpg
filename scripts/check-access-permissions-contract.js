'use strict';

const assert = require('assert');

const {
    ACCESS_ROLE_KEYS,
    CHARACTER_READ_PERMISSIONS,
    ROLE_DEFINITIONS,
    getRoleDefinition,
    roleGrantsPermission,
} = require('../helpers/clover/accessControlService');
const {
    ACCESS_PERMISSIONS,
    EXTRA_ROLE_PERMISSIONS,
    roleGrantsIntegratedPermission,
} = require('../helpers/clover/accessIntegrationService');

const EXPECTED_ROLE_KEYS = Object.freeze([
    'admin',
    'narrator',
    'evaluator',
    'captain',
    'vice_captain',
]);

const EXPECTED_ACCESS_PERMISSIONS = Object.freeze({
    PROFILE_READ: 'character.read.profile',
    CAPACITY_READ: 'character.read.capacity',
    CAPACITY_TECHNICAL: 'character.read.capacity.technical',
    GRIMOIRE_READ: 'character.read.grimoire',
    GRIMOIRE_TECHNICAL: 'character.read.grimoire.technical',
    SQUAD_STATE_READ: 'squad.read.state',
    SQUAD_MEMBERS_READ: 'squad.read.members',
    SQUAD_MEMBERS_MANAGE: 'squad.manage.members',
    SQUAD_RESOURCES_READ: 'squad.read.resources',
    SQUAD_UPGRADES_MANAGE: 'squad.manage.upgrades',
    RAID_CREATE: 'raid.create',
    RAID_READ_ALL: 'raid.read.all',
    RAID_MANAGE: 'raid.manage',
    RAID_REWARD_REVIEW: 'raid.reward.review',
    PERFORMANCE_TEAM_MANAGE: 'performance_team.manage',
});

const EXPECTED_CHARACTER_READ = Object.freeze([
    'character.read.profile',
    'character.read.progress',
    'character.read.capacity',
    'character.read.grimoire',
]);

const EXPECTED_ROLES = Object.freeze({
    admin: {
        scopeType: 'global',
        permissions: ['*'],
    },
    narrator: {
        scopeType: 'global',
        permissions: [
            ...EXPECTED_CHARACTER_READ,
            'squad.read.state',
            'squad.read.members',
            'squad.read.resources',
            'raid.create',
            'raid.read.all',
            'raid.manage',
        ],
    },
    evaluator: {
        scopeType: 'global',
        permissions: [
            ...EXPECTED_CHARACTER_READ,
            'evaluation.apply',
            'raid.reward.review',
        ],
    },
    captain: {
        scopeType: 'squad',
        permissions: [
            ...EXPECTED_CHARACTER_READ,
            'squad.read.state',
            'squad.read.members',
            'squad.read.resources',
            'squad.manage.members',
            'raid.create',
            'raid.manage',
        ],
    },
    vice_captain: {
        scopeType: 'squad',
        permissions: [
            ...EXPECTED_CHARACTER_READ,
            'squad.read.state',
            'squad.read.members',
            'squad.read.resources',
        ],
    },
});

const EXPECTED_EXTRA_PERMISSIONS = Object.freeze({
    admin: ['*'],
    evaluator: [
        'character.read.capacity.technical',
        'character.read.grimoire.technical',
        'raid.reward.review',
    ],
    captain: [
        'squad.manage.upgrades',
        'squad.manage.members',
        'raid.create',
        'raid.manage',
    ],
    vice_captain: [
        'squad.manage.upgrades',
    ],
});

function sorted(values) {
    return [...values].sort();
}

function assertSameSet(actual, expected, label) {
    assert.deepStrictEqual(sorted(actual), sorted(expected), label);
}

assertSameSet(ACCESS_ROLE_KEYS, EXPECTED_ROLE_KEYS, 'role keys changed');
assert(!ACCESS_ROLE_KEYS.includes('owner'), 'owner must not be a database role');
assert.deepStrictEqual(ACCESS_PERMISSIONS, EXPECTED_ACCESS_PERMISSIONS, 'access permissions changed');
assertSameSet(CHARACTER_READ_PERMISSIONS, EXPECTED_CHARACTER_READ, 'character read permissions changed');

for (const [roleKey, expected] of Object.entries(EXPECTED_ROLES)) {
    const definition = ROLE_DEFINITIONS[roleKey];
    assert(definition, `missing role ${roleKey}`);
    assert.strictEqual(definition.scopeType, expected.scopeType, `${roleKey} scope changed`);
    assertSameSet(definition.permissions, expected.permissions, `${roleKey} permissions changed`);
    assert.strictEqual(getRoleDefinition(roleKey)?.key, roleKey, `${roleKey} lookup failed`);
}

assert.deepStrictEqual(EXTRA_ROLE_PERMISSIONS, EXPECTED_EXTRA_PERMISSIONS, 'integrated extra permissions changed');

assert.strictEqual(roleGrantsPermission('admin', 'anything.future'), true, 'admin must grant wildcard');
assert.strictEqual(roleGrantsIntegratedPermission('admin', 'anything.future'), true, 'admin integrated wildcard failed');
assert.strictEqual(roleGrantsIntegratedPermission('admin', ACCESS_PERMISSIONS.PERFORMANCE_TEAM_MANAGE), true);
assert.strictEqual(roleGrantsIntegratedPermission('evaluator', ACCESS_PERMISSIONS.CAPACITY_TECHNICAL), true);
assert.strictEqual(roleGrantsIntegratedPermission('evaluator', ACCESS_PERMISSIONS.GRIMOIRE_TECHNICAL), true);
assert.strictEqual(roleGrantsIntegratedPermission('captain', ACCESS_PERMISSIONS.SQUAD_UPGRADES_MANAGE), true);
assert.strictEqual(roleGrantsIntegratedPermission('vice_captain', ACCESS_PERMISSIONS.SQUAD_UPGRADES_MANAGE), true);
assert.strictEqual(roleGrantsIntegratedPermission('vice_captain', ACCESS_PERMISSIONS.SQUAD_MEMBERS_MANAGE), false);
assert.strictEqual(roleGrantsIntegratedPermission('evaluator', ACCESS_PERMISSIONS.SQUAD_MEMBERS_MANAGE), false);

console.log('Access permission contract OK.');
