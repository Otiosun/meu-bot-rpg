'use strict';

const { isOwner, isSameUser, normalizeJid } = require('../groupAccess');
const { canManagePlayer, getPlayerById } = require('./commandTargetUtils');
const {
    authorizeTargetAccess,
    getAccessContext,
    normalizeScopeKey,
    roleGrantsPermission,
} = require('./accessControlService');
const {
    authorizeCanonicalSquadAccess,
    authorizeCanonicalTargetAccess,
} = require('./canonicalScopedAccessService');
const { resolvePlayerSquadMembership } = require('./squadMembershipReadService');

const ACCESS_PERMISSIONS = Object.freeze({
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

const EXTRA_ROLE_PERMISSIONS = Object.freeze({
    admin: Object.freeze(['*']),
    evaluator: Object.freeze([
        ACCESS_PERMISSIONS.CAPACITY_TECHNICAL,
        ACCESS_PERMISSIONS.GRIMOIRE_TECHNICAL,
        ACCESS_PERMISSIONS.RAID_REWARD_REVIEW,
    ]),
    captain: Object.freeze([
        ACCESS_PERMISSIONS.SQUAD_UPGRADES_MANAGE,
        ACCESS_PERMISSIONS.SQUAD_MEMBERS_MANAGE,
        ACCESS_PERMISSIONS.RAID_CREATE,
        ACCESS_PERMISSIONS.RAID_MANAGE,
    ]),
    vice_captain: Object.freeze([
        ACCESS_PERMISSIONS.SQUAD_UPGRADES_MANAGE,
    ]),
});

function roleGrantsIntegratedPermission(roleKey, permission) {
    if (roleGrantsPermission(roleKey, permission)) return true;
    const extra = EXTRA_ROLE_PERMISSIONS[roleKey] || [];
    return extra.includes('*') || extra.includes(permission);
}

function assignmentMatchesTargetSquad(assignment, targetPlayer) {
    if (assignment.scope_type === 'global') return true;
    const targetSquadKey = normalizeScopeKey(targetPlayer?.esquadrao || targetPlayer?.squad_key);
    return Boolean(targetSquadKey && targetSquadKey === assignment.scope_key);
}

function preserveScopedAuthorizationCode(result) {
    if (!result?.ok || !result.assignment) return result;
    return {
        ...result,
        code: result.assignment.scope_type === 'global' ? 'global_role' : 'squad_role',
        reader: 'canonical_scoped',
    };
}

async function authorizeCharacterAccess(db, {
    actorId,
    targetPlayer,
    permission,
    allowSelf = true,
}) {
    const actor = normalizeJid(actorId);
    const targetId = normalizeJid(targetPlayer?.id || targetPlayer?.player_id);
    if (!actor || !targetId || !permission) {
        return { ok: false, code: 'invalid_request', actorId: actor, targetId, permission };
    }

    if (isOwner(actor)) {
        return { ok: true, code: 'owner', actorId: actor, targetId, permission };
    }
    if (allowSelf && isSameUser(actor, targetId)) {
        return { ok: true, code: 'self', actorId: actor, targetId, permission };
    }

    const canonical = await authorizeCanonicalTargetAccess(db, {
        actorId: actor,
        targetPlayer,
        permission,
        permissionResolver: roleGrantsIntegratedPermission,
    });
    if (canonical.ok) return preserveScopedAuthorizationCode(canonical);
    if (canonical.fallbackAllowed !== true) return canonical;

    const base = await authorizeTargetAccess(db, { actorId: actor, targetPlayer, permission });
    if (base.ok) return { ...base, reader: 'legacy_scoped_fallback' };

    const context = base.context || await getAccessContext(db, actor);
    for (const assignment of context.assignments) {
        if (!roleGrantsIntegratedPermission(assignment.role_key, permission)) continue;
        if (!assignmentMatchesTargetSquad(assignment, targetPlayer)) continue;
        return {
            ok: true,
            code: assignment.scope_type === 'global' ? 'global_role' : 'squad_role',
            actorId: actor,
            targetId,
            permission,
            assignment,
            reader: 'legacy_scoped_fallback',
        };
    }

    return { ...base, context, permission, reader: 'legacy_scoped_fallback' };
}

async function authorizeCharacterCommandAccess({
    db,
    sock,
    idChat,
    actorId,
    targetPlayer,
    permission,
    allowSelf = true,
    allowLegacyAdmin = true,
    specialViewer = null,
}) {
    const roleAccess = await authorizeCharacterAccess(db, {
        actorId,
        targetPlayer,
        permission,
        allowSelf,
    });
    if (roleAccess.ok) return roleAccess;

    if (typeof specialViewer === 'function' && specialViewer(actorId)) {
        return { ok: true, code: 'special_viewer', permission };
    }
    if (allowLegacyAdmin && await canManagePlayer(sock, idChat, actorId)) {
        return { ok: true, code: 'legacy_group_admin', permission };
    }
    return roleAccess;
}

async function getActorPlayer(db, actorId) {
    const normalized = normalizeJid(actorId);
    if (!normalized) return null;
    return getPlayerById(db, normalized).catch(() => null);
}

async function authorizeSquadAccess(db, {
    actorId,
    squad,
    permission,
    allowMemberRead = true,
}) {
    const actor = normalizeJid(actorId);
    const squadKey = normalizeScopeKey(squad?.squad_key || squad?.name || squad);
    if (!actor || !squadKey || !permission) {
        return { ok: false, code: 'invalid_request', actorId: actor, squadKey, permission };
    }
    if (isOwner(actor)) {
        return { ok: true, code: 'owner', actorId: actor, squadKey, permission };
    }

    if (allowMemberRead && permission.startsWith('squad.read.')) {
        const actorPlayer = await getActorPlayer(db, actor);
        const membership = await resolvePlayerSquadMembership(db, actorPlayer || actor);
        if (!membership.ok && membership.code === 'multiple_active_memberships') {
            return {
                ok: false,
                code: 'membership_conflict',
                actorId: actor,
                squadKey,
                permission,
                reader: 'canonical_membership',
            };
        }
        if (membership.ok && membership.squadKey === squadKey) {
            return {
                ok: true,
                code: 'own_squad',
                actorId: actor,
                squadKey,
                permission,
                reader: membership.source,
            };
        }
    }

    const canonical = await authorizeCanonicalSquadAccess(db, {
        actorId: actor,
        squadKey,
        permission,
        permissionResolver: roleGrantsIntegratedPermission,
    });
    if (canonical.ok) return preserveScopedAuthorizationCode(canonical);
    if (canonical.fallbackAllowed !== true) return canonical;

    const context = await getAccessContext(db, actor);
    for (const assignment of context.assignments) {
        if (!roleGrantsIntegratedPermission(assignment.role_key, permission)) continue;
        if (assignment.scope_type === 'global') {
            return {
                ok: true,
                code: 'global_role',
                actorId: actor,
                squadKey,
                permission,
                assignment,
                reader: 'legacy_scoped_fallback',
            };
        }
        if (assignment.scope_type === 'squad' && assignment.scope_key === squadKey) {
            return {
                ok: true,
                code: 'squad_role',
                actorId: actor,
                squadKey,
                permission,
                assignment,
                reader: 'legacy_scoped_fallback',
            };
        }
    }

    return {
        ok: false,
        code: 'forbidden',
        actorId: actor,
        squadKey,
        permission,
        context,
        reader: 'legacy_scoped_fallback',
    };
}

module.exports = {
    ACCESS_PERMISSIONS,
    EXTRA_ROLE_PERMISSIONS,
    assignmentMatchesTargetSquad,
    authorizeCharacterAccess,
    authorizeCharacterCommandAccess,
    authorizeSquadAccess,
    preserveScopedAuthorizationCode,
    roleGrantsIntegratedPermission,
};
