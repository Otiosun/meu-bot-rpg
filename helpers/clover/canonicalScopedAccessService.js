'use strict';

const { isOwner, normalizeJid } = require('../groupAccess');
const { normalizeSquadKey } = require('./cavalierService');
const {
    CANONICAL_ROLE_DEFINITIONS,
} = require('./canonicalRoleDefinitions');
const {
    readCanonicalRoleContextReadOnly,
} = require('./canonicalRoleShadowReadOnly');
const { equivalentPlayerIds } = require('./playerIdentityEquivalenceService');

const CANONICAL_ACCESS_ROLE_KEYS = Object.freeze([
    'admin',
    'narrator',
    'evaluator',
    'captain',
    'vice_captain',
]);
const ALIAS_EXPANDABLE_ROLE_KEYS = Object.freeze(['captain', 'vice_captain']);

function defaultPermissionResolver(roleKey, permission) {
    const definition = CANONICAL_ROLE_DEFINITIONS[roleKey];
    if (!definition) return false;
    return definition.permissions.includes('*')
        || definition.permissions.includes(permission);
}

function normalizeCanonicalAssignment(grant, options = {}) {
    return {
        id: grant.id,
        subject_id: grant.subjectId,
        role_key: grant.roleKey,
        scope_type: grant.scopeType,
        scope_key: grant.scopeKey,
        status: grant.status,
        source: options.viaAlias ? 'canonical_role_grant_alias' : 'canonical_role_grant',
        origin_type: grant.originType,
        origin_ref: grant.originRef,
        metadata: {
            ...(grant.metadata || {}),
            ...(options.viaAlias ? { equivalent_identity: true } : {}),
        },
        role: CANONICAL_ROLE_DEFINITIONS[grant.roleKey] || null,
    };
}

function dedupeAssignments(assignments) {
    const result = [];
    const seen = new Set();
    for (const assignment of assignments || []) {
        const key = [
            assignment.role_key,
            assignment.scope_type,
            assignment.scope_key,
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(assignment);
    }
    return result;
}

async function getCanonicalScopedAccessContext(db, actorId, options = {}) {
    const actor = normalizeJid(actorId);
    const ownerCheck = options.ownerCheck || isOwner;
    const owner = Boolean(actor && ownerCheck(actor));
    const emptyContext = {
        subjectId: actor,
        owner: false,
        grants: [],
        roleKeys: [],
        conflicts: [],
    };
    const directContext = actor
        ? await readCanonicalRoleContextReadOnly(db, actor, {
            includeLegacy: false,
            ownerCheck,
            referenceDate: options.referenceDate,
        })
        : emptyContext;

    const assignments = [];
    for (const grant of directContext.grants || []) {
        if (!CANONICAL_ACCESS_ROLE_KEYS.includes(grant.roleKey)) continue;
        assignments.push(normalizeCanonicalAssignment(grant));
    }

    const equivalentIds = actor
        ? await equivalentPlayerIds(db, actor)
        : [];
    for (const equivalentId of equivalentIds) {
        if (!equivalentId || equivalentId === actor) continue;
        const aliasContext = await readCanonicalRoleContextReadOnly(db, equivalentId, {
            includeLegacy: false,
            ownerCheck: () => false,
            referenceDate: options.referenceDate,
        });
        for (const grant of aliasContext.grants || []) {
            if (!ALIAS_EXPANDABLE_ROLE_KEYS.includes(grant.roleKey)) continue;
            if (grant.scopeType !== 'squad' || !grant.scopeKey) continue;
            assignments.push(normalizeCanonicalAssignment(grant, { viaAlias: true }));
        }
    }

    const effectiveAssignments = dedupeAssignments(assignments);
    return {
        actorId: actor,
        owner,
        available: owner || effectiveAssignments.length > 0,
        assignments: effectiveAssignments,
        roleKeys: [...new Set(effectiveAssignments.map((assignment) => assignment.role_key))].sort(),
        squadScopes: [...new Set(effectiveAssignments
            .filter((assignment) => assignment.scope_type === 'squad')
            .map((assignment) => assignment.scope_key)
            .filter(Boolean))].sort(),
        source: 'canonical_role_grants',
        sourceContext: directContext,
        equivalentIdentityCount: Math.max(0, equivalentIds.length - (actor ? 1 : 0)),
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
            source: assignment.source,
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
            source: assignment.source,
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
    ALIAS_EXPANDABLE_ROLE_KEYS,
    CANONICAL_ACCESS_ROLE_KEYS,
    assignmentGrantsPermission,
    assignmentMatchesSquad,
    authorizeCanonicalSquadAccess,
    authorizeCanonicalTargetAccess,
    dedupeAssignments,
    defaultPermissionResolver,
    getCanonicalScopedAccessContext,
    normalizeCanonicalAssignment,
};
