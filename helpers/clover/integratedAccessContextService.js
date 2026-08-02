'use strict';

const { isOwner, normalizeJid } = require('../groupAccess');
const {
    CANONICAL_ROLE_DEFINITIONS,
} = require('./canonicalRoleDefinitions');
const {
    getCanonicalScopedAccessContext,
} = require('./canonicalScopedAccessService');
const {
    EXTRA_ROLE_PERMISSIONS,
} = require('./accessIntegrationService');
const {
    getAccessContext: getLegacyAccessContext,
} = require('./accessControlLegacyService');

function uniqueSorted(values) {
    return [...new Set((values || []).filter(Boolean))].sort();
}

function assignmentMatchesSquad(assignment, squadKey) {
    if (!assignment) return false;
    return assignment.scope_type === 'global'
        || (assignment.scope_type === 'squad' && assignment.scope_key === squadKey);
}

function assignmentBasePermissions(assignment) {
    if (!assignment) return [];
    if (assignment.source === 'canonical_role_grant') {
        return CANONICAL_ROLE_DEFINITIONS[assignment.role_key]?.permissions || [];
    }
    return assignment.role?.permissions || [];
}

function assignmentPermissionCatalog(assignment) {
    return uniqueSorted([
        ...assignmentBasePermissions(assignment),
        ...(EXTRA_ROLE_PERMISSIONS[assignment?.role_key] || []),
    ]);
}

function assignmentGrantsIntegratedPermission(assignment, permission) {
    if (!assignment || !permission) return false;
    const permissions = assignmentPermissionCatalog(assignment);
    return permissions.includes('*') || permissions.includes(permission);
}

function buildGlobalPermissions(assignments, owner = false) {
    if (owner) return ['*'];
    const permissions = [];
    for (const assignment of assignments || []) {
        if (assignment.scope_type !== 'global') continue;
        for (const permission of assignmentPermissionCatalog(assignment)) {
            if (permission !== '*') permissions.push(permission);
        }
    }
    return uniqueSorted(permissions);
}

function contextHasGlobalAdministration(context) {
    if (context?.owner) return true;
    return (context?.assignments || []).some((assignment) => (
        assignment.scope_type === 'global'
        && assignment.role_key === 'admin'
    ));
}

function contextCanAnywhere(context, permission) {
    if (!context || !permission) return false;
    if (context.owner) return true;
    return (context.assignments || []).some((assignment) => (
        assignmentGrantsIntegratedPermission(assignment, permission)
    ));
}

function contextCanForSquad(context, permission, squadKey) {
    if (!context || !permission || !squadKey) return false;
    if (context.owner) return true;
    return (context.assignments || []).some((assignment) => (
        assignmentMatchesSquad(assignment, squadKey)
        && assignmentGrantsIntegratedPermission(assignment, permission)
    ));
}

function normalizeIntegratedContext(context, source) {
    const assignments = [...(context?.assignments || [])];
    const owner = Boolean(context?.owner);
    return {
        actorId: normalizeJid(context?.actorId),
        owner,
        assignments,
        roleKeys: uniqueSorted(assignments.map((assignment) => assignment.role_key)),
        permissions: buildGlobalPermissions(assignments, owner),
        squadScopes: uniqueSorted(assignments
            .filter((assignment) => assignment.scope_type === 'squad')
            .map((assignment) => assignment.scope_key)),
        source,
        canonical: source === 'canonical_role_grants',
        legacyFallback: source === 'legacy_access_fallback',
    };
}

async function getIntegratedAccessContext(db, actorId, options = {}) {
    const actor = normalizeJid(actorId);
    const ownerCheck = options.ownerCheck || isOwner;
    const canonical = await getCanonicalScopedAccessContext(db, actor, {
        ownerCheck,
        referenceDate: options.referenceDate,
    });

    if (canonical.available) {
        return normalizeIntegratedContext(canonical, 'canonical_role_grants');
    }

    const legacy = await getLegacyAccessContext(db, actor);
    return normalizeIntegratedContext(legacy, 'legacy_access_fallback');
}

module.exports = {
    assignmentBasePermissions,
    assignmentGrantsIntegratedPermission,
    assignmentMatchesSquad,
    assignmentPermissionCatalog,
    buildGlobalPermissions,
    contextCanAnywhere,
    contextCanForSquad,
    contextHasGlobalAdministration,
    getIntegratedAccessContext,
    normalizeIntegratedContext,
    uniqueSorted,
};
