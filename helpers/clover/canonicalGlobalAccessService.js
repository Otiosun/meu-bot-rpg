'use strict';

const { isOwner, normalizeJid } = require('../groupAccess');
const {
    assignmentGrantsPermission,
    defaultPermissionResolver,
    getCanonicalScopedAccessContext,
} = require('./canonicalScopedAccessService');

async function authorizeCanonicalGlobalPermission(db, {
    actorId,
    permission,
    permissionResolver = defaultPermissionResolver,
    ownerCheck = isOwner,
    referenceDate = null,
}) {
    const actor = normalizeJid(actorId);
    if (!actor || !permission) {
        return {
            ok: false,
            code: 'invalid_request',
            fallbackAllowed: false,
            actorId: actor,
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
            permission,
            context,
        };
    }

    for (const assignment of context.assignments) {
        if (assignment.scope_type !== 'global') continue;
        if (!assignmentGrantsPermission(assignment, permission, permissionResolver)) continue;
        return {
            ok: true,
            code: 'canonical_global_role',
            actorId: actor,
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
        permission,
        context,
    };
}

module.exports = {
    authorizeCanonicalGlobalPermission,
};
