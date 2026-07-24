'use strict';

const crypto = require('crypto');
const { isOwner, normalizeJid } = require('../groupAccess');
const {
    ASSIGNABLE_ROLES,
    AdminAccessError,
    assertOwnerAccess,
    ensureAdminAccessSchema,
    listAdminRoles,
    revokeAdminRole,
    setAdminRole,
} = require('./adminAccessService');
const { getRoleCapabilities, normalizeRole } = require('./adminOperationContract');

const CHANGE_STATUSES = Object.freeze(['draft', 'applied', 'cancelled', 'undone', 'expired']);
const CHANGE_ACTIONS = Object.freeze(['set', 'revoke']);
const DEFAULT_EXPIRY_MINUTES = 15;

class AdminTeamError extends Error {
    constructor(message, code = 'admin_team_error', status = 400, details = null) {
        super(message);
        this.name = 'AdminTeamError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

async function ensureAdminTeamSchema(db) {
    await ensureAdminAccessSchema(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_admin_access_changes (
            code TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK (status IN ('draft', 'applied', 'cancelled', 'undone', 'expired')),
            action TEXT NOT NULL CHECK (action IN ('set', 'revoke')),
            actor_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            requested_role TEXT DEFAULT NULL,
            reason TEXT NOT NULL,
            before_json TEXT NOT NULL,
            after_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            applied_at TEXT DEFAULT NULL,
            applied_by TEXT DEFAULT NULL,
            undone_at TEXT DEFAULT NULL,
            undone_by TEXT DEFAULT NULL,
            undo_reason TEXT DEFAULT NULL
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_admin_access_changes_recent
        ON clover_admin_access_changes (created_at DESC, status)
    `);
}

function text(value) {
    return String(value || '').trim();
}

function requiredText(value, label) {
    const result = text(value);
    if (!result) throw new AdminTeamError(`${label} é obrigatório.`, 'missing_field', 400, { field: label });
    return result;
}

function canonicalId(value) {
    const id = normalizeJid(value);
    if (!id || !id.includes('@')) {
        throw new AdminTeamError('Identidade administrativa inválida.', 'invalid_admin_identity', 400);
    }
    return id;
}

function generateChangeCode(randomBytes = crypto.randomBytes) {
    return `AC-${randomBytes(4).toString('hex').toUpperCase()}`;
}

function parseJson(value, fallback = null) {
    try {
        return value ? JSON.parse(value) : fallback;
    } catch {
        return fallback;
    }
}

function roleSnapshot(row) {
    if (!row) return null;
    return {
        playerId: row.player_id,
        role: row.role,
        active: Number(row.active) === 1,
        grantedBy: row.granted_by || null,
        grantedAt: row.granted_at || null,
        updatedAt: row.updated_at || null,
        revokedBy: row.revoked_by || null,
        revokedAt: row.revoked_at || null,
    };
}

async function readRoleRow(db, targetId) {
    await ensureAdminAccessSchema(db);
    return db.get(
        `SELECT player_id, role, active, granted_by, granted_at, updated_at, revoked_by, revoked_at
         FROM clover_admin_roles WHERE player_id = ?`,
        [canonicalId(targetId)]
    );
}

function sameRoleState(left, right) {
    if (!left && !right) return true;
    if (!left || !right) return false;
    return left.playerId === right.playerId
        && left.role === right.role
        && Boolean(left.active) === Boolean(right.active);
}

async function findPlayer(db, playerId) {
    const id = canonicalId(playerId);
    try {
        return await db.get(
            `SELECT id, personagem_nome, nome, numero, esquadrao_nome, jogo_status
             FROM jogadores WHERE id = ?`,
            [id]
        );
    } catch (error) {
        if (/no such column/i.test(String(error?.message || ''))) {
            return db.get('SELECT id, personagem_nome FROM jogadores WHERE id = ?', [id]);
        }
        throw error;
    }
}

function maskIdentity(value) {
    const raw = text(value);
    const [user = '', domain = ''] = raw.split('@');
    if (!user) return '—';
    const visible = user.length <= 6 ? user.slice(0, 2) : `${user.slice(0, 3)}…${user.slice(-3)}`;
    return domain ? `${visible}@${domain}` : visible;
}

function roleRecord(row, player = null) {
    const active = Number(row.active) === 1;
    const role = normalizeRole(row.role);
    return {
        playerId: row.player_id,
        identityMasked: maskIdentity(row.player_id),
        characterName: player?.personagem_nome || player?.nome || maskIdentity(row.player_id),
        squad: player?.esquadrao_nome || null,
        gameStatus: player?.jogo_status || null,
        role,
        capabilities: getRoleCapabilities(role),
        active,
        source: 'admin_role',
        grantedByMasked: maskIdentity(row.granted_by),
        grantedAt: row.granted_at || null,
        updatedAt: row.updated_at || null,
        revokedByMasked: row.revoked_by ? maskIdentity(row.revoked_by) : null,
        revokedAt: row.revoked_at || null,
    };
}

async function enrichRows(db, rows) {
    const result = [];
    for (const row of rows) {
        const player = await findPlayer(db, row.player_id).catch(() => null);
        result.push(roleRecord(row, player));
    }
    return result;
}

async function listAdminTeam(db, options = {}) {
    await ensureAdminTeamSchema(db);
    const includeRevoked = Boolean(options.includeRevoked);
    const stored = await listAdminRoles(db);
    const filtered = includeRevoked ? stored : stored.filter((row) => Number(row.active) === 1);
    const members = await enrichRows(db, filtered);
    const ownerId = options.ownerActor?.id ? canonicalId(options.ownerActor.id) : null;
    const ownerPlayer = ownerId ? await findPlayer(db, ownerId).catch(() => null) : null;
    const owner = ownerId ? {
        playerId: ownerId,
        identityMasked: maskIdentity(ownerId),
        characterName: ownerPlayer?.personagem_nome || ownerPlayer?.nome || options.ownerActor?.displayName || 'Proprietário',
        squad: ownerPlayer?.esquadrao_nome || null,
        gameStatus: ownerPlayer?.jogo_status || null,
        role: 'owner',
        capabilities: getRoleCapabilities('owner'),
        active: true,
        source: 'owner_config',
        grantedByMasked: null,
        grantedAt: null,
        updatedAt: null,
        revokedByMasked: null,
        revokedAt: null,
        immutable: true,
    } : null;
    const recentChanges = await listAdminAccessChanges(db, { limit: options.changeLimit || 20 });
    return {
        ok: true,
        owner,
        members,
        activeCount: members.filter((member) => member.active).length + (owner ? 1 : 0),
        revokedCount: stored.filter((row) => Number(row.active) !== 1).length,
        recentChanges,
        assignableRoles: ASSIGNABLE_ROLES.map((role) => ({
            role,
            capabilities: getRoleCapabilities(role),
        })),
    };
}

async function createAdminAccessChange(db, input = {}, options = {}) {
    const actor = await assertOwnerAccess(db, input.actorId, options);
    await ensureAdminTeamSchema(db);
    const targetId = canonicalId(input.targetId);
    const action = text(input.action).toLowerCase();
    if (!CHANGE_ACTIONS.includes(action)) {
        throw new AdminTeamError('Ação de acesso inválida.', 'invalid_access_change_action', 400, { action });
    }
    if ((options.ownerCheck || isOwner)(targetId)) {
        throw new AdminTeamError('O acesso do Proprietário é controlado pela configuração e não pode ser alterado aqui.', 'target_is_owner', 409);
    }
    const player = await findPlayer(db, targetId);
    if (!player) throw new AdminTeamError('Jogador não encontrado.', 'player_not_found', 404, { targetId });
    const reason = requiredText(input.reason, 'Motivo');
    const before = roleSnapshot(await readRoleRow(db, targetId));
    let role = null;
    let after;
    if (action === 'set') {
        role = normalizeRole(input.role);
        if (!ASSIGNABLE_ROLES.includes(role)) {
            throw new AdminTeamError('Este cargo não pode ser atribuído manualmente.', 'unassignable_admin_role', 400, { role });
        }
        if (before?.active && before.role === role) {
            throw new AdminTeamError('Esta pessoa já possui esse cargo.', 'admin_role_unchanged', 409, { targetId, role });
        }
        after = { playerId: targetId, role, active: true };
    } else {
        if (!before?.active) {
            throw new AdminTeamError('Esta pessoa não possui acesso administrativo ativo.', 'admin_role_not_active', 409, { targetId });
        }
        after = { playerId: targetId, role: before.role, active: false };
    }
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const expiryMinutes = Math.max(1, Math.min(60, Number(options.expiryMinutes || DEFAULT_EXPIRY_MINUTES)));
    const expiresAt = new Date(now.getTime() + expiryMinutes * 60_000);
    const code = generateChangeCode(options.randomBytes);
    await db.run(
        `INSERT INTO clover_admin_access_changes
         (code, status, action, actor_id, target_id, requested_role, reason,
          before_json, after_json, created_at, expires_at)
         VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            code,
            action,
            actor.id,
            targetId,
            role,
            reason,
            JSON.stringify(before),
            JSON.stringify(after),
            now.toISOString(),
            expiresAt.toISOString(),
        ]
    );
    return {
        ok: true,
        change: await getAdminAccessChange(db, code),
        target: {
            playerId: targetId,
            identityMasked: maskIdentity(targetId),
            characterName: player.personagem_nome || player.nome || maskIdentity(targetId),
        },
    };
}

async function getAdminAccessChange(db, code) {
    await ensureAdminTeamSchema(db);
    const normalized = text(code).toUpperCase();
    const row = await db.get('SELECT * FROM clover_admin_access_changes WHERE code = ?', [normalized]);
    if (!row) throw new AdminTeamError('Alteração de acesso não encontrada.', 'access_change_not_found', 404, { code: normalized });
    return {
        code: row.code,
        status: row.status,
        action: row.action,
        actorIdMasked: maskIdentity(row.actor_id),
        targetId: row.target_id,
        targetIdMasked: maskIdentity(row.target_id),
        requestedRole: row.requested_role || null,
        reason: row.reason,
        before: parseJson(row.before_json, null),
        after: parseJson(row.after_json, null),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        appliedAt: row.applied_at || null,
        appliedByMasked: row.applied_by ? maskIdentity(row.applied_by) : null,
        undoneAt: row.undone_at || null,
        undoneByMasked: row.undone_by ? maskIdentity(row.undone_by) : null,
        undoReason: row.undo_reason || null,
    };
}

async function markExpired(db, change, now) {
    if (change.status !== 'draft') return change;
    if (new Date(change.expiresAt).getTime() > now.getTime()) return change;
    await db.run("UPDATE clover_admin_access_changes SET status = 'expired' WHERE code = ? AND status = 'draft'", [change.code]);
    throw new AdminTeamError('Esta prévia expirou. Gere uma nova alteração.', 'access_change_expired', 409, { code: change.code });
}

async function applyAdminAccessChange(db, code, actorId, options = {}) {
    const actor = await assertOwnerAccess(db, actorId, options);
    await ensureAdminTeamSchema(db);
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const change = await getAdminAccessChange(db, code);
    await markExpired(db, change, now);
    if (change.status !== 'draft') {
        throw new AdminTeamError('Esta alteração não está mais aguardando aplicação.', 'access_change_not_draft', 409, { code: change.code, status: change.status });
    }
    const current = roleSnapshot(await readRoleRow(db, change.targetId));
    if (!sameRoleState(current, change.before)) {
        throw new AdminTeamError('O cargo mudou depois da prévia. Revise e gere uma nova alteração.', 'access_change_stale', 409, { current, expected: change.before });
    }
    await db.exec('BEGIN IMMEDIATE');
    try {
        if (change.action === 'set') {
            await setAdminRole(db, {
                actorId: actor.id,
                targetId: change.targetId,
                role: change.requestedRole,
            }, options);
        } else {
            await revokeAdminRole(db, {
                actorId: actor.id,
                targetId: change.targetId,
            }, options);
        }
        await db.run(
            `UPDATE clover_admin_access_changes
             SET status = 'applied', applied_at = ?, applied_by = ?
             WHERE code = ? AND status = 'draft'`,
            [now.toISOString(), actor.id, change.code]
        );
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
    return { ok: true, change: await getAdminAccessChange(db, change.code) };
}

async function restoreRoleSnapshot(db, snapshot) {
    if (!snapshot) return;
    await ensureAdminAccessSchema(db);
    await db.run(
        `INSERT INTO clover_admin_roles
         (player_id, role, active, granted_by, granted_at, updated_at, revoked_by, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET
            role = excluded.role,
            active = excluded.active,
            granted_by = excluded.granted_by,
            granted_at = excluded.granted_at,
            updated_at = excluded.updated_at,
            revoked_by = excluded.revoked_by,
            revoked_at = excluded.revoked_at`,
        [
            snapshot.playerId,
            snapshot.role,
            snapshot.active ? 1 : 0,
            snapshot.grantedBy || 'system',
            snapshot.grantedAt || new Date().toISOString(),
            snapshot.updatedAt || new Date().toISOString(),
            snapshot.revokedBy || null,
            snapshot.revokedAt || null,
        ]
    );
}

async function undoAdminAccessChange(db, code, actorId, reason, options = {}) {
    const actor = await assertOwnerAccess(db, actorId, options);
    await ensureAdminTeamSchema(db);
    const change = await getAdminAccessChange(db, code);
    if (change.status !== 'applied') {
        throw new AdminTeamError('Somente alterações aplicadas podem ser desfeitas.', 'access_change_not_applied', 409, { code: change.code, status: change.status });
    }
    const current = roleSnapshot(await readRoleRow(db, change.targetId));
    if (!sameRoleState(current, change.after)) {
        throw new AdminTeamError('O cargo recebeu outra alteração depois desta ação e não pode ser desfeito automaticamente.', 'access_change_changed_after_apply', 409, { current, expected: change.after });
    }
    const undoReason = requiredText(reason, 'Motivo para desfazer');
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    await db.exec('BEGIN IMMEDIATE');
    try {
        if (change.before) {
            await restoreRoleSnapshot(db, change.before);
        } else {
            await db.run('DELETE FROM clover_admin_roles WHERE player_id = ?', [change.targetId]);
        }
        await db.run(
            `UPDATE clover_admin_access_changes
             SET status = 'undone', undone_at = ?, undone_by = ?, undo_reason = ?
             WHERE code = ? AND status = 'applied'`,
            [now.toISOString(), actor.id, undoReason, change.code]
        );
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
    return { ok: true, change: await getAdminAccessChange(db, change.code) };
}

async function cancelAdminAccessChange(db, code, actorId, options = {}) {
    const actor = await assertOwnerAccess(db, actorId, options);
    await ensureAdminTeamSchema(db);
    const change = await getAdminAccessChange(db, code);
    if (change.status !== 'draft') {
        throw new AdminTeamError('Somente prévias pendentes podem ser canceladas.', 'access_change_not_draft', 409, { code: change.code, status: change.status });
    }
    await db.run(
        "UPDATE clover_admin_access_changes SET status = 'cancelled', applied_by = ? WHERE code = ? AND status = 'draft'",
        [actor.id, change.code]
    );
    return { ok: true, change: await getAdminAccessChange(db, change.code) };
}

async function listAdminAccessChanges(db, options = {}) {
    await ensureAdminTeamSchema(db);
    const limit = Math.max(1, Math.min(100, Number(options.limit || 20)));
    const rows = await db.all(
        `SELECT code FROM clover_admin_access_changes
         ORDER BY created_at DESC LIMIT ?`,
        [limit]
    );
    const changes = [];
    for (const row of rows || []) changes.push(await getAdminAccessChange(db, row.code));
    return changes;
}

module.exports = {
    AdminTeamError,
    CHANGE_ACTIONS,
    CHANGE_STATUSES,
    applyAdminAccessChange,
    cancelAdminAccessChange,
    createAdminAccessChange,
    ensureAdminTeamSchema,
    generateChangeCode,
    getAdminAccessChange,
    listAdminAccessChanges,
    listAdminTeam,
    maskIdentity,
    undoAdminAccessChange,
};
