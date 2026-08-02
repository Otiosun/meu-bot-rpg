'use strict';

const { isOwner, normalizeJid } = require('../groupAccess');
const { normalizeSquadKey } = require('./cavalierService');
const {
    CANONICAL_ROLE_DEFINITIONS,
} = require('./canonicalRoleDefinitions');
const {
    readCanonicalRoleContextReadOnly,
} = require('./canonicalRoleShadowReadOnly');

const CANONICAL_ACCESS_ROLE_KEYS = Object.freeze([
    'admin',
    'narrator',
    'evaluator',
    'captain',
    'vice_captain',
]);

function defaultPermissionResolver(roleKey, permission) {
    const definition = CANONICAL_ROLE_DEFINITIONS[roleKey];
    if (!definition) return false;
    return definition.permissions.includes('*')
        || definition.permissions.includes(permission);
}

function normalizeCanonicalAssignment(grant) {
    return {
        id: grant.id,
        subject_id: grant.subjectId,
        role_key: grant.roleKey,
        scope_type: grant.scopeType,
        scope_key: grant.scopeKey,
        status: grant.status,
        source: 'canonical_role_grant',
        origin_type: grant.originType,
        origin_ref: grant.originRef,
        metadata: grant.metadata || {},
        role: CANONICAL_ROLE_DEFINITIONS[grant.roleKey] || null,
    };
}

async function getCanonicalScopedAccessContext(db, actorId, options = {}) {
    const actor = normalizeJid(actorId);
    const ownerCheck = options.ownerCheck || isOwner;
    const owner = Boolean(actor && ownerCheck(actor));
    const sourceContext = actor
        ? await readCanonicalRoleContextReadOnly(db, actor, {
            includeLegacy: false,
            ownerCheck,
            referenceDate: options.referenceDate,
        })
        : {
            subjectId: actor,
            owner: false,
            grants: [],
            roleKeys: [],
            conflicts: [],
        };
    const grants = (sourceContext.grants || []).filter((grant) => (
        CANONICAL_ACCESS_ROLE_KEYS.includes(grant.roleKey)
    ));
    const assignments = grants.map(normalizeCanonicalAssignment);

    return {
        actorId: actor,
        owner,
        available: owner || assignments.length > 0,
        assignments,
        roleKeys: [...new Set(assignments.map((assignment) => assignment.role_key))].sort(),
        squadScopes: [...new Set(assignments
            .filter((assignment) => assignment.scope_type === 'squad')
            .map((assignment) => assignment.scope_key)
            .filter(Boolean))].sort(),
        source: 'canonical_role_grants',
        sourceContext,
    };
}

function assignmentGrantsPermission(assignment, permission, permissionResolver = defaultPermissionResolver) {
    if (!assignment || !permission) return false;
    return Boolean(permissionResolver(assignment.role_key, permission));
}

function assignmentMatchesSquad(assignment, squadKey) {
    if (!assignment) return false;
    if (assignment.scope_type === 'global') return true;
    const normalized = normalizeSquadKey(squadKey);
    return Boolean(
        assignment.scope_type === 'squad'
        && normalized
        && assignment.scope_key === normalized
    );
}

async function authorizeCanonicalTargetAccess(db, {
    actorId,
    targetPlayer,
    permission,
    permissionResolver = defaultPermissionResolver,
    ownerCheck = isOwner,
    referenceDate = null,
}) {
    const actor = normalizeJid(actorId);
    const targetId = normalizeJid(targetPlayer?.id || targetPlayer?.player_id);
    if (!actor || !targetId || !permission) {
        return {
            ok: false,
            code: 'invalid_request',
            fallbackAllowed: false,
            actorId: actor,
            targetId,
            permission,
        };
    }

    const context = await getCanonicalScopedAccessContext(db, actor, {
        ownerCheck,
        referenceDate,
    });
    if (context.owner) {
        return {
            ok: true,
            code: 'owner',
            actorId: actor,
            targetId,
            permission,
            source: 'owner_config',
            context,
        };
    }
    if (!context.available) {
        return {
            ok: false,
            code: 'canonical_access_unavailable',
            fallbackAllowed: true,
            actorId: actor,
            targetId,
            permission,
            context,
        };
    }

    const targetSquadKey = normalizeSquadKey(targetPlayer?.esquadrao || targetPlayer?.squad_key);
    for (const assignment of context.assignments) {
        if (!assignmentGrantsPermission(assignment, permission, permissionResolver)) continue;
        if (!assignmentMatchesSquad(assignment, targetSquadKey)) continue;
        return {
            ok: true,
            code: assignment.scope_type === 'global'
                ? 'canonical_global_role'
                : 'canonical_squad_role',
            actorId: actor,
            targetId,
            targetSquadKey,
            permission,
            assignment,
            source: 'canonical_role_grant',
            context,
        };
    }

    return {
        ok: false,
        code: 'forbidden',
        fallbackAllowed: false,
        actorId: actor,
        targetId,
        targetSquadKey,
        permission,
        context,
    };
}

async function authorizeCanonicalSquadAccess(db, {
    actorId,
    squadKey,
    permission,
    permissionResolver = defaultPermissionResolver,
    ownerCheck = isOwner,
    referenceDate = null,
}) {
    const actor = normalizeJid(actorId);
    const normalizedSquad = normalizeSquadKey(squadKey);
    if (!actor || !normalizedSquad || !permission) {
        return {
            ok: false,
            code: 'invalid_request',
            fallbackAllowed: false,
            actorId: actor,
            squadKey: normalizedSquad,
            permission,
        };
    }

    const context = await getCanonicalScopedAccessContext(db, actor, {
        ownerCheck,
        referenceDate,
    });
    if (context.owner) {
        return {
            ok: true,
            code: 'owner',
            actorId: actor,
            squadKey: normalizedSquad,
            permission,
            source: 'owner_config',
            context,
        };
    }
    if (!context.available) {
        return {
            ok: false,
            code: 'canonical_access_unavailable',
            fallbackAllowed: true,
            actorId: actor,
            squadKey: normalizedSquad,
            permission,
            context,
        };
    }

    for (const assignment of context.assignments) {
        if (!assignmentGrantsPermission(assignment, permission, permissionResolver)) continue;
        if (!assignmentMatchesSquad(assignment, normalizedSquad)) continue;
        return {
            ok: true,
            code: assignment.scope_type === 'global'
                ? 'canonical_global_role'
                : 'canonical_squad_role',
            actorId: actor,
            squadKey: normalizedSquad,
            permission,
            assignment,
            source: 'canonical_role_grant',
            context,
        };
    }

    return {
        ok: false,
        code: 'forbidden',
        fallbackAllowed: false,
        actorId: actor,
        squadKey: normalizedSquad,
        permission,
        context,
    };
}

module.exports = {
    CANONICAL_ACCESS_ROLE_KEYS,
    assignmentGrantsPermission,
    assignmentMatchesSquad,
    authorizeCanonicalSquadAccess,
    authorizeCanonicalTargetAccess,
    defaultPermissionResolver,
    getCanonicalScopedAccessContext,
    normalizeCanonicalAssignment,
};
