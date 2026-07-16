'use strict';

const { isOwner, isSameUser, normalizeJid } = require('../groupAccess');
const { canManagePlayer, getPlayerById } = require('./commandTargetUtils');
const {
    authorizeTargetAccess,
    getAccessContext,
    normalizeScopeKey,
    roleGrantsPermission,
} = require('./accessControlService');

const ACCESS_PERMISSIONS = Object.freeze({
    PROFILE_READ: 'character.read.profile',
    CAPACITY_READ: 'character.read.capacity',
    CAPACITY_TECHNICAL: 'character.read.capacity.technical',
    GRIMOIRE_READ: 'character.read.grimoire',
    GRIMOIRE_TECHNICAL: 'character.read.grimoire.technical',
    SQUAD_STATE_READ: 'squad.read.state',
    SQUAD_RESOURCES_READ: 'squad.read.resources',
    SQUAD_UPGRADES_MANAGE: 'squad.manage.upgrades',
});

const EXTRA_ROLE_PERMISSIONS = Object.freeze({
    admin: Object.freeze(['*']),
    evaluator: Object.freeze([
        ACCESS_PERMISSIONS.CAPACITY_TECHNICAL,
        ACCESS_PERMISSIONS.GRIMOIRE_TECHNICAL,
    ]),
    captain: Object.freeze([
        ACCESS_PERMISSIONS.SQUAD_UPGRADES_MANAGE,
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

    const base = await authorizeTargetAccess(db, { actorId: actor, targetPlayer, permission });
    if (base.ok) return base;

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
        };
    }

    return { ...base, context, permission };
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
        const actorSquadKey = normalizeScopeKey(actorPlayer?.esquadrao);
        if (actorSquadKey && actorSquadKey === squadKey) {
            return { ok: true, code: 'own_squad', actorId: actor, squadKey, permission };
        }
    }

    const context = await getAccessContext(db, actor);
    for (const assignment of context.assignments) {
        if (!roleGrantsIntegratedPermission(assignment.role_key, permission)) continue;
        if (assignment.scope_type === 'global') {
            return { ok: true, code: 'global_role', actorId: actor, squadKey, permission, assignment };
        }
        if (assignment.scope_type === 'squad' && assignment.scope_key === squadKey) {
            return { ok: true, code: 'squad_role', actorId: actor, squadKey, permission, assignment };
        }
    }

    return { ok: false, code: 'forbidden', actorId: actor, squadKey, permission, context };
}

module.exports = {
    ACCESS_PERMISSIONS,
    EXTRA_ROLE_PERMISSIONS,
    assignmentMatchesTargetSquad,
    authorizeCharacterAccess,
    authorizeCharacterCommandAccess,
    authorizeSquadAccess,
    roleGrantsIntegratedPermission,
};
