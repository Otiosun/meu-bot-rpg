'use strict';

const { isOwner, normalizeJid } = require('../groupAccess');
const {
    ADMIN_ROLES,
    getRoleCapabilities,
    normalizeRole,
} = require('./adminOperationContract');

const ASSIGNABLE_ROLES = Object.freeze([
    ADMIN_ROLES.ADMIN,
    ADMIN_ROLES.EVALUATOR,
    ADMIN_ROLES.NARRATOR,
    ADMIN_ROLES.ASSISTANT,
]);

class AdminAccessError extends Error {
    constructor(message, code = 'admin_access_error', details = null) {
        super(message);
        this.name = 'AdminAccessError';
        this.code = code;
        this.details = details;
    }
}

async function ensureAdminAccessSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_admin_roles (
            player_id TEXT PRIMARY KEY,
            role TEXT NOT NULL CHECK (role IN ('admin', 'evaluator', 'narrator', 'assistant')),
            active INTEGER NOT NULL DEFAULT 1,
            granted_by TEXT NOT NULL,
            granted_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            revoked_by TEXT DEFAULT NULL,
            revoked_at TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_admin_roles_active
        ON clover_admin_roles (active, role, updated_at DESC)
    `);
}

function canonicalActorId(playerId) {
    const normalized = normalizeJid(playerId);
    if (!normalized || !normalized.includes('@')) {
        throw new AdminAccessError('Identidade administrativa inválida.', 'invalid_admin_identity', { playerId });
    }
    return normalized;
}

async function getAdminActorAccess(db, playerId, options = {}) {
    const actorId = canonicalActorId(playerId);
    const ownerCheck = options.ownerCheck || isOwner;

    if (ownerCheck(actorId)) {
        return {
            ok: true,
            actor: {
                id: actorId,
                role: ADMIN_ROLES.OWNER,
                capabilities: getRoleCapabilities(ADMIN_ROLES.OWNER),
                source: 'owner_config',
            },
        };
    }

    await ensureAdminAccessSchema(db);
    const row = await db.get(
        `SELECT player_id, role, active, granted_by, granted_at, updated_at
         FROM clover_admin_roles
         WHERE player_id = ?`,
        [actorId]
    );

    if (!row || Number(row.active) !== 1) {
        return {
            ok: false,
            code: 'admin_access_denied',
            actorId,
        };
    }

    let role;
    try {
        role = normalizeRole(row.role);
    } catch {
        return {
            ok: false,
            code: 'invalid_stored_admin_role',
            actorId,
        };
    }

    return {
        ok: true,
        actor: {
            id: actorId,
            role,
            capabilities: getRoleCapabilities(role),
            source: 'admin_role',
            grantedBy: row.granted_by,
            grantedAt: row.granted_at,
            updatedAt: row.updated_at,
        },
    };
}

async function assertOwnerAccess(db, actorId, options = {}) {
    const access = await getAdminActorAccess(db, actorId, options);
    if (!access.ok || access.actor.role !== ADMIN_ROLES.OWNER) {
        throw new AdminAccessError('Apenas o Owner pode alterar permissões administrativas.', 'owner_required');
    }
    return access.actor;
}

async function setAdminRole(db, input, options = {}) {
    const actor = await assertOwnerAccess(db, input.actorId, options);
    const targetId = canonicalActorId(input.targetId);
    const role = normalizeRole(input.role);

    if (!ASSIGNABLE_ROLES.includes(role)) {
        throw new AdminAccessError('Esse perfil não pode ser atribuído manualmente.', 'unassignable_admin_role', { role });
    }
    if ((options.ownerCheck || isOwner)(targetId)) {
        throw new AdminAccessError('O Owner já possui acesso total pela configuração.', 'target_is_owner');
    }

    await ensureAdminAccessSchema(db);
    await db.run(
        `INSERT INTO clover_admin_roles (
            player_id, role, active, granted_by, granted_at, updated_at, revoked_by, revoked_at
         ) VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL)
         ON CONFLICT(player_id) DO UPDATE SET
            role = excluded.role,
            active = 1,
            granted_by = excluded.granted_by,
            granted_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP,
            revoked_by = NULL,
            revoked_at = NULL`,
        [targetId, role, actor.id]
    );

    return getAdminActorAccess(db, targetId, options);
}

async function revokeAdminRole(db, input, options = {}) {
    const actor = await assertOwnerAccess(db, input.actorId, options);
    const targetId = canonicalActorId(input.targetId);

    if ((options.ownerCheck || isOwner)(targetId)) {
        throw new AdminAccessError('O acesso do Owner não pode ser revogado pelo banco.', 'target_is_owner');
    }

    await ensureAdminAccessSchema(db);
    const result = await db.run(
        `UPDATE clover_admin_roles
         SET active = 0,
             revoked_by = ?,
             revoked_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ? AND active = 1`,
        [actor.id, targetId]
    );

    return {
        ok: true,
        targetId,
        changed: Number(result?.changes || 0) === 1,
    };
}

async function listAdminRoles(db) {
    await ensureAdminAccessSchema(db);
    const rows = await db.all(
        `SELECT player_id, role, active, granted_by, granted_at, updated_at, revoked_by, revoked_at
         FROM clover_admin_roles
         ORDER BY active DESC, role ASC, updated_at DESC`
    );
    return rows || [];
}

module.exports = {
    ASSIGNABLE_ROLES,
    AdminAccessError,
    assertOwnerAccess,
    ensureAdminAccessSchema,
    getAdminActorAccess,
    listAdminRoles,
    revokeAdminRole,
    setAdminRole,
};
