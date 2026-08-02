'use strict';

const crypto = require('crypto');
const { isOwner, normalizeJid } = require('../groupAccess');
const {
    assertOwnerAccess,
    ensureAdminAccessSchema,
} = require('./adminAccessService');
const {
    CANONICAL_ROLE_DEFINITIONS,
    getCanonicalRoleDefinition,
    resolveCanonicalRoleKey,
} = require('./canonicalRoleDefinitions');
const {
    ensureCanonicalRoleGrantSchema,
    isGrantActiveAt,
    rowToGrant,
} = require('./canonicalRoleGrantSchema');

const ADMIN_ROLE_KEYS = Object.freeze(['admin', 'evaluator', 'narrator', 'assistant']);
const CHANGE_ACTIONS = Object.freeze(['set', 'revoke']);
const CHANGE_STATUSES = Object.freeze(['draft', 'applied', 'cancelled', 'undone', 'expired']);
const DEFAULT_EXPIRY_MINUTES = 15;

class CanonicalAdminTeamError extends Error {
    constructor(message, code = 'canonical_admin_team_error', status = 400, details = null) {
        super(message || code);
        this.name = 'CanonicalAdminTeamError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function cleanText(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function requiredText(value, field) {
    const result = cleanText(value);
    if (!result) {
        throw new CanonicalAdminTeamError(
            `${field} é obrigatório.`,
            'missing_field',
            400,
            { field }
        );
    }
    return result;
}

function canonicalId(value) {
    const id = normalizeJid(value);
    if (!id || !id.includes('@')) {
        throw new CanonicalAdminTeamError(
            'Identidade administrativa inválida.',
            'invalid_admin_identity',
            400,
            { value }
        );
    }
    return id;
}

function adminRoleKey(value) {
    const role = resolveCanonicalRoleKey(value);
    if (!role || !ADMIN_ROLE_KEYS.includes(role)) {
        throw new CanonicalAdminTeamError(
            'Este cargo não pode ser atribuído pela Equipe ADM.',
            'unassignable_admin_role',
            400,
            { role: value || null }
        );
    }
    return role;
}

function generateChangeCode(randomBytes = crypto.randomBytes) {
    return `AC-${randomBytes(5).toString('hex').toUpperCase()}`;
}

function parseJson(value, fallback = null) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, stable(value[key])])
    );
}

function stateFingerprint(state) {
    return JSON.stringify(stable(state));
}

function maskIdentity(value) {
    const raw = cleanText(value);
    const [user = '', domain = ''] = raw.split('@');
    if (!user) return '—';
    const visible = user.length <= 6
        ? `${user.slice(0, 2)}…`
        : `${user.slice(0, 3)}…${user.slice(-3)}`;
    return domain ? `${visible}@${domain}` : visible;
}

async function ensureCanonicalAdminTeamSchema(db) {
    await ensureAdminAccessSchema(db);
    await ensureCanonicalRoleGrantSchema(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_canonical_admin_role_changes (
            code TEXT PRIMARY KEY,
            status TEXT NOT NULL
                CHECK (status IN ('draft', 'applied', 'cancelled', 'undone', 'expired')),
            action TEXT NOT NULL CHECK (action IN ('set', 'revoke')),
            actor_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            requested_role TEXT DEFAULT NULL,
            reason TEXT NOT NULL,
            before_state_json TEXT NOT NULL,
            planned_after_json TEXT NOT NULL,
            applied_state_json TEXT DEFAULT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            applied_at TEXT DEFAULT NULL,
            applied_by TEXT DEFAULT NULL,
            cancelled_at TEXT DEFAULT NULL,
            cancelled_by TEXT DEFAULT NULL,
            undone_at TEXT DEFAULT NULL,
            undone_by TEXT DEFAULT NULL,
            undo_reason TEXT DEFAULT NULL
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_canonical_admin_changes_recent
        ON clover_canonical_admin_role_changes (created_at DESC, status)
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_canonical_admin_changes_target
        ON clover_canonical_admin_role_changes (target_id, created_at DESC)
    `);
}

async function findPlayer(db, targetId) {
    const id = canonicalId(targetId);
    const columns = await db.all('PRAGMA table_info(jogadores)').catch(() => []);
    if (!columns.length) return null;
    const available = new Set(columns.map((column) => column.name));
    const optional = (name, alias = name) => (
        available.has(name) ? `${name} AS ${alias}` : `NULL AS ${alias}`
    );
    return db.get(
        `SELECT id,
                ${optional('personagem_nome')},
                ${optional('nome')},
                ${optional('esquadrao', 'squad_name')},
                ${optional('jogo_status')}
         FROM jogadores
         WHERE id = ?`,
        [id]
    );
}

async function readLegacyAdmissionRow(db, targetId) {
    return db.get(
        `SELECT player_id, role, active, granted_by, granted_at, updated_at,
                revoked_by, revoked_at
         FROM clover_admin_roles
         WHERE player_id = ?`,
        [canonicalId(targetId)]
    );
}

async function readCanonicalAdminRows(db, targetId) {
    const placeholders = ADMIN_ROLE_KEYS.map(() => '?').join(', ');
    return db.all(
        `SELECT *
         FROM clover_role_grants
         WHERE subject_id = ?
           AND scope_type = 'global'
           AND scope_key = '*'
           AND role_key IN (${placeholders})
           AND status = 'active'
         ORDER BY role_key, id`,
        [canonicalId(targetId), ...ADMIN_ROLE_KEYS]
    );
}

function serializeLegacy(row) {
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

function serializeCanonicalRow(row, referenceDate) {
    const grant = rowToGrant(row, 'canonical');
    return {
        id: Number(row.id),
        roleKey: row.role_key,
        status: row.status,
        effective: isGrantActiveAt(grant, referenceDate),
        validFrom: row.valid_from || row.created_at || null,
        validUntil: row.valid_until || null,
        grantedBy: row.granted_by || null,
        grantReason: row.grant_reason || null,
        originType: row.origin_type || null,
        originRef: row.origin_ref || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
    };
}

function classifyParity(legacy, canonicalRows) {
    const effectiveRoles = [...new Set(
        canonicalRows.filter((grant) => grant.effective).map((grant) => grant.roleKey)
    )].sort();
    const legacyRole = legacy?.active && ADMIN_ROLE_KEYS.includes(legacy.role)
        ? legacy.role
        : null;

    if (!legacyRole && effectiveRoles.length === 0) return 'none';
    if (effectiveRoles.length > 1) return 'ambiguous_canonical';
    if (!legacyRole && effectiveRoles.length === 1) return 'canonical_only';
    if (legacyRole && effectiveRoles.length === 0) return 'legacy_only';
    return legacyRole === effectiveRoles[0] ? 'matched' : 'mismatch';
}

async function readAdminRoleStateUnchecked(db, targetId, referenceDate = new Date()) {
    const target = canonicalId(targetId);
    const [legacyRow, canonicalRows] = await Promise.all([
        readLegacyAdmissionRow(db, target),
        readCanonicalAdminRows(db, target),
    ]);
    const legacy = serializeLegacy(legacyRow);
    const canonical = (canonicalRows || []).map((row) => (
        serializeCanonicalRow(row, referenceDate)
    ));
    const parity = classifyParity(legacy, canonical);
    const effectiveRoles = [...new Set(
        canonical.filter((grant) => grant.effective).map((grant) => grant.roleKey)
    )].sort();
    return {
        targetId: target,
        legacy,
        canonical,
        effectiveRoles,
        parity,
    };
}

async function readAdminRoleState(db, targetId, options = {}) {
    await ensureCanonicalAdminTeamSchema(db);
    return readAdminRoleStateUnchecked(
        db,
        targetId,
        options.referenceDate || new Date()
    );
}

function assertStateManageable(state) {
    if (state.parity === 'none' || state.parity === 'matched') return;
    throw new CanonicalAdminTeamError(
        'O cargo possui divergência entre a fonte canônica e a admissão legada.',
        'admin_role_integrity_conflict',
        409,
        {
            targetId: state.targetId,
            parity: state.parity,
            legacyRole: state.legacy?.active ? state.legacy.role : null,
            canonicalRoles: state.effectiveRoles,
        }
    );
}

function plannedAfterState(targetId, action, role) {
    if (action === 'revoke') {
        return {
            targetId,
            role: null,
            active: false,
            parity: 'none',
        };
    }
    return {
        targetId,
        role,
        active: true,
        parity: 'matched',
    };
}

function stateMatchesPlanned(state, planned) {
    if (!planned.active) {
        return state.parity === 'none'
            && !state.legacy?.active
            && state.effectiveRoles.length === 0;
    }
    return state.parity === 'matched'
        && state.legacy?.active
        && state.legacy.role === planned.role
        && state.effectiveRoles.length === 1
        && state.effectiveRoles[0] === planned.role;
}

async function writeGrantEvent(db, row, action, actorId, reason, payload = {}) {
    await db.run(
        `INSERT INTO clover_role_grant_events
         (grant_id, subject_id, role_key, scope_type, scope_key, action,
          performed_by, reason, origin_type, origin_ref, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            row.id || null,
            row.subject_id,
            row.role_key,
            row.scope_type,
            row.scope_key,
            action,
            canonicalId(actorId),
            cleanText(reason) || null,
            row.origin_type || 'admin_team',
            row.origin_ref || null,
            JSON.stringify(payload || {}),
        ]
    );
}

async function revokeCanonicalAdminRowsInTransaction(
    db,
    rows,
    actorId,
    reason,
    payload = {}
) {
    for (const row of rows || []) {
        const changed = await db.run(
            `UPDATE clover_role_grants
             SET status = 'revoked',
                 revoked_at = CURRENT_TIMESTAMP,
                 revoked_by = ?,
                 revoke_reason = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'active'`,
            [canonicalId(actorId), cleanText(reason) || null, row.id]
        );
        if (Number(changed.changes || 0) !== 1) {
            throw new CanonicalAdminTeamError(
                'O grant canônico mudou durante a alteração.',
                'canonical_grant_change_conflict',
                409,
                { grantId: row.id }
            );
        }
        await writeGrantEvent(db, row, 'revoked', actorId, reason, payload);
    }
}

async function insertCanonicalAdminGrantInTransaction(
    db,
    targetId,
    role,
    actorId,
    reason,
    changeCode,
    metadata = {}
) {
    const definition = getCanonicalRoleDefinition(role);
    if (!definition || definition.scopeType !== 'global' || !ADMIN_ROLE_KEYS.includes(definition.key)) {
        throw new CanonicalAdminTeamError(
            'Cargo administrativo canônico inválido.',
            'invalid_canonical_admin_role',
            400,
            { role }
        );
    }
    const inserted = await db.run(
        `INSERT INTO clover_role_grants
         (subject_id, role_key, scope_type, scope_key, status, valid_from,
          granted_by, grant_reason, origin_type, origin_ref, metadata_json)
         VALUES (?, ?, 'global', '*', 'active', CURRENT_TIMESTAMP,
                 ?, ?, 'admin_team', ?, ?)`,
        [
            canonicalId(targetId),
            definition.key,
            canonicalId(actorId),
            cleanText(reason) || null,
            changeCode,
            JSON.stringify({ changeCode, ...metadata }),
        ]
    );
    const row = await db.get(
        'SELECT * FROM clover_role_grants WHERE id = ?',
        [inserted.lastID]
    );
    await writeGrantEvent(db, row, 'granted', actorId, reason, {
        changeCode,
        ...metadata,
    });
    return row;
}

async function setLegacyAdmissionInTransaction(db, targetId, role, actorId) {
    await db.run(
        `INSERT INTO clover_admin_roles
         (player_id, role, active, granted_by, granted_at, updated_at,
          revoked_by, revoked_at)
         VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL)
         ON CONFLICT(player_id) DO UPDATE SET
            role = excluded.role,
            active = 1,
            granted_by = excluded.granted_by,
            granted_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP,
            revoked_by = NULL,
            revoked_at = NULL`,
        [canonicalId(targetId), adminRoleKey(role), canonicalId(actorId)]
    );
}

async function revokeLegacyAdmissionInTransaction(db, targetId, actorId) {
    await db.run(
        `UPDATE clover_admin_roles
         SET active = 0,
             revoked_by = ?,
             revoked_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ? AND active = 1`,
        [canonicalId(actorId), canonicalId(targetId)]
    );
}

async function applyDesiredRoleStateInTransaction(
    db,
    currentState,
    desiredRole,
    actorId,
    reason,
    changeCode,
    metadata = {}
) {
    const rows = await readCanonicalAdminRows(db, currentState.targetId);
    await revokeCanonicalAdminRowsInTransaction(
        db,
        rows,
        actorId,
        reason,
        { changeCode, ...metadata }
    );
    if (desiredRole) {
        await insertCanonicalAdminGrantInTransaction(
            db,
            currentState.targetId,
            desiredRole,
            actorId,
            reason,
            changeCode,
            metadata
        );
        await setLegacyAdmissionInTransaction(
            db,
            currentState.targetId,
            desiredRole,
            actorId
        );
    } else {
        await revokeLegacyAdmissionInTransaction(db, currentState.targetId, actorId);
    }
}

function serializeChangeRow(row) {
    if (!row) return null;
    return {
        code: row.code,
        status: row.status,
        action: row.action,
        actorIdMasked: maskIdentity(row.actor_id),
        targetId: row.target_id,
        targetIdMasked: maskIdentity(row.target_id),
        requestedRole: row.requested_role || null,
        reason: row.reason,
        before: parseJson(row.before_state_json, null),
        plannedAfter: parseJson(row.planned_after_json, null),
        appliedState: parseJson(row.applied_state_json, null),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        appliedAt: row.applied_at || null,
        appliedByMasked: row.applied_by ? maskIdentity(row.applied_by) : null,
        cancelledAt: row.cancelled_at || null,
        cancelledByMasked: row.cancelled_by ? maskIdentity(row.cancelled_by) : null,
        undoneAt: row.undone_at || null,
        undoneByMasked: row.undone_by ? maskIdentity(row.undone_by) : null,
        undoReason: row.undo_reason || null,
    };
}

async function getCanonicalAdminRoleChange(db, code) {
    await ensureCanonicalAdminTeamSchema(db);
    const normalized = cleanText(code).toUpperCase();
    const row = await db.get(
        'SELECT * FROM clover_canonical_admin_role_changes WHERE code = ?',
        [normalized]
    );
    if (!row) {
        throw new CanonicalAdminTeamError(
            'Alteração de cargo não encontrada.',
            'admin_role_change_not_found',
            404,
            { code: normalized }
        );
    }
    return serializeChangeRow(row);
}

async function listCanonicalAdminRoleChanges(db, options = {}) {
    await ensureCanonicalAdminTeamSchema(db);
    const limit = Math.max(1, Math.min(100, Number(options.limit || 30)));
    const rows = await db.all(
        `SELECT *
         FROM clover_canonical_admin_role_changes
         ORDER BY created_at DESC, code DESC
         LIMIT ?`,
        [limit]
    );
    return (rows || []).map(serializeChangeRow);
}

function memberFromState(state, player = null) {
    const matchedRole = state.parity === 'matched' ? state.effectiveRoles[0] : null;
    const definition = matchedRole ? CANONICAL_ROLE_DEFINITIONS[matchedRole] : null;
    return {
        playerId: state.targetId,
        identityMasked: maskIdentity(state.targetId),
        characterName: player?.personagem_nome || player?.nome || maskIdentity(state.targetId),
        squad: player?.squad_name || null,
        gameStatus: player?.jogo_status || null,
        role: matchedRole,
        roleLabel: definition?.label || null,
        capabilities: definition?.permissions || [],
        parity: state.parity,
        canonicalRoles: state.effectiveRoles,
        legacyRole: state.legacy?.active ? state.legacy.role : null,
        grantIds: state.canonical.filter((grant) => grant.effective).map((grant) => grant.id),
        active: state.parity === 'matched',
    };
}

async function listCanonicalAdminTeam(db, options = {}) {
    const owner = await assertOwnerAccess(db, options.actorId, options);
    await ensureCanonicalAdminTeamSchema(db);
    const placeholders = ADMIN_ROLE_KEYS.map(() => '?').join(', ');
    const [legacyRows, canonicalRows] = await Promise.all([
        db.all(
            `SELECT player_id FROM clover_admin_roles
             WHERE active = 1
             ORDER BY player_id`
        ),
        db.all(
            `SELECT DISTINCT subject_id AS player_id
             FROM clover_role_grants
             WHERE status = 'active'
               AND scope_type = 'global'
               AND scope_key = '*'
               AND role_key IN (${placeholders})
             ORDER BY subject_id`,
            ADMIN_ROLE_KEYS
        ),
    ]);
    const subjects = [...new Set([
        ...(legacyRows || []).map((row) => row.player_id),
        ...(canonicalRows || []).map((row) => row.player_id),
    ].filter(Boolean))].sort();
    const members = [];
    for (const subject of subjects) {
        const [state, player] = await Promise.all([
            readAdminRoleStateUnchecked(db, subject, options.referenceDate || new Date()),
            findPlayer(db, subject).catch(() => null),
        ]);
        members.push(memberFromState(state, player));
    }
    const ownerPlayer = await findPlayer(db, owner.id).catch(() => null);
    return {
        ok: true,
        owner: {
            playerId: owner.id,
            identityMasked: maskIdentity(owner.id),
            characterName: ownerPlayer?.personagem_nome || ownerPlayer?.nome || 'Proprietário',
            role: 'owner',
            roleLabel: CANONICAL_ROLE_DEFINITIONS.owner.label,
            capabilities: CANONICAL_ROLE_DEFINITIONS.owner.permissions,
            immutable: true,
            active: true,
            parity: 'owner_config',
        },
        members,
        activeCount: members.filter((member) => member.active).length + 1,
        integrityConflictCount: members.filter((member) => !['matched', 'none'].includes(member.parity)).length,
        assignableRoles: ADMIN_ROLE_KEYS.map((role) => ({
            role,
            label: CANONICAL_ROLE_DEFINITIONS[role].label,
            capabilities: CANONICAL_ROLE_DEFINITIONS[role].permissions,
        })),
        recentChanges: await listCanonicalAdminRoleChanges(db, {
            limit: options.changeLimit || 30,
        }),
    };
}

async function createCanonicalAdminRoleChange(db, input = {}, options = {}) {
    const actor = await assertOwnerAccess(db, input.actorId, options);
    await ensureCanonicalAdminTeamSchema(db);
    const targetId = canonicalId(input.targetId);
    if ((options.ownerCheck || isOwner)(targetId)) {
        throw new CanonicalAdminTeamError(
            'O Proprietário é definido pela configuração e não pode ser alterado.',
            'target_is_owner',
            409
        );
    }
    const player = await findPlayer(db, targetId);
    if (!player) {
        throw new CanonicalAdminTeamError(
            'Jogador não encontrado.',
            'player_not_found',
            404,
            { targetId }
        );
    }
    const action = cleanText(input.action).toLowerCase();
    if (!CHANGE_ACTIONS.includes(action)) {
        throw new CanonicalAdminTeamError(
            'Ação de cargo inválida.',
            'invalid_admin_role_change_action',
            400,
            { action }
        );
    }
    const reason = requiredText(input.reason, 'Motivo');
    const before = await readAdminRoleStateUnchecked(
        db,
        targetId,
        options.referenceDate || new Date()
    );
    assertStateManageable(before);

    const role = action === 'set' ? adminRoleKey(input.role) : null;
    if (action === 'set'
        && before.parity === 'matched'
        && before.effectiveRoles.length === 1
        && before.effectiveRoles[0] === role) {
        throw new CanonicalAdminTeamError(
            'Esta pessoa já possui esse cargo canônico.',
            'admin_role_unchanged',
            409,
            { targetId, role }
        );
    }
    if (action === 'revoke' && before.parity === 'none') {
        throw new CanonicalAdminTeamError(
            'Esta pessoa não possui cargo administrativo ativo.',
            'admin_role_not_active',
            409,
            { targetId }
        );
    }

    const now = options.now instanceof Date
        ? options.now
        : new Date(options.now || Date.now());
    const expiryMinutes = Math.max(
        1,
        Math.min(60, Number(options.expiryMinutes || DEFAULT_EXPIRY_MINUTES))
    );
    const expiresAt = new Date(now.getTime() + expiryMinutes * 60_000);
    const code = generateChangeCode(options.randomBytes);
    const plannedAfter = plannedAfterState(targetId, action, role);

    await db.run(
        `INSERT INTO clover_canonical_admin_role_changes
         (code, status, action, actor_id, target_id, requested_role, reason,
          before_state_json, planned_after_json, created_at, expires_at)
         VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            code,
            action,
            actor.id,
            targetId,
            role,
            reason,
            JSON.stringify(before),
            JSON.stringify(plannedAfter),
            now.toISOString(),
            expiresAt.toISOString(),
        ]
    );
    return {
        ok: true,
        change: await getCanonicalAdminRoleChange(db, code),
        target: {
            playerId: targetId,
            identityMasked: maskIdentity(targetId),
            characterName: player.personagem_nome || player.nome || maskIdentity(targetId),
        },
    };
}

async function expireDraftIfNeeded(db, change, now) {
    if (change.status !== 'draft') return;
    if (new Date(change.expiresAt).getTime() > now.getTime()) return;
    await db.run(
        `UPDATE clover_canonical_admin_role_changes
         SET status = 'expired'
         WHERE code = ? AND status = 'draft'`,
        [change.code]
    );
    throw new CanonicalAdminTeamError(
        'Esta prévia expirou. Gere uma nova alteração.',
        'admin_role_change_expired',
        409,
        { code: change.code }
    );
}

async function applyCanonicalAdminRoleChange(db, code, actorId, options = {}) {
    const actor = await assertOwnerAccess(db, actorId, options);
    await ensureCanonicalAdminTeamSchema(db);
    const now = options.now instanceof Date
        ? options.now
        : new Date(options.now || Date.now());
    const change = await getCanonicalAdminRoleChange(db, code);
    await expireDraftIfNeeded(db, change, now);
    if (change.status !== 'draft') {
        throw new CanonicalAdminTeamError(
            'Esta alteração não está aguardando aplicação.',
            'admin_role_change_not_draft',
            409,
            { code: change.code, status: change.status }
        );
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        const current = await readAdminRoleStateUnchecked(
            db,
            change.targetId,
            options.referenceDate || now
        );
        if (stateFingerprint(current) !== stateFingerprint(change.before)) {
            throw new CanonicalAdminTeamError(
                'O cargo mudou depois da prévia.',
                'admin_role_change_stale',
                409,
                { current, expected: change.before }
            );
        }
        const desiredRole = change.action === 'set' ? change.requestedRole : null;
        await applyDesiredRoleStateInTransaction(
            db,
            current,
            desiredRole,
            actor.id,
            change.reason,
            change.code,
            { action: change.action }
        );
        const appliedState = await readAdminRoleStateUnchecked(
            db,
            change.targetId,
            options.referenceDate || now
        );
        if (!stateMatchesPlanned(appliedState, change.plannedAfter)) {
            throw new CanonicalAdminTeamError(
                'A pós-condição do cargo não foi confirmada.',
                'admin_role_change_postcondition_failed',
                409,
                { appliedState, plannedAfter: change.plannedAfter }
            );
        }
        const updated = await db.run(
            `UPDATE clover_canonical_admin_role_changes
             SET status = 'applied',
                 applied_state_json = ?,
                 applied_at = ?,
                 applied_by = ?
             WHERE code = ? AND status = 'draft'`,
            [JSON.stringify(appliedState), now.toISOString(), actor.id, change.code]
        );
        if (Number(updated.changes || 0) !== 1) {
            throw new CanonicalAdminTeamError(
                'A alteração mudou durante a aplicação.',
                'admin_role_change_claim_conflict',
                409,
                { code: change.code }
            );
        }
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
    return {
        ok: true,
        change: await getCanonicalAdminRoleChange(db, change.code),
        state: await readAdminRoleState(db, change.targetId, options),
    };
}

async function cancelCanonicalAdminRoleChange(db, code, actorId, options = {}) {
    const actor = await assertOwnerAccess(db, actorId, options);
    await ensureCanonicalAdminTeamSchema(db);
    const now = options.now instanceof Date
        ? options.now
        : new Date(options.now || Date.now());
    const change = await getCanonicalAdminRoleChange(db, code);
    await expireDraftIfNeeded(db, change, now);
    if (change.status !== 'draft') {
        throw new CanonicalAdminTeamError(
            'Somente prévias pendentes podem ser canceladas.',
            'admin_role_change_not_cancellable',
            409,
            { code: change.code, status: change.status }
        );
    }
    const updated = await db.run(
        `UPDATE clover_canonical_admin_role_changes
         SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?
         WHERE code = ? AND status = 'draft'`,
        [now.toISOString(), actor.id, change.code]
    );
    if (Number(updated.changes || 0) !== 1) {
        throw new CanonicalAdminTeamError(
            'A prévia mudou antes do cancelamento.',
            'admin_role_change_claim_conflict',
            409,
            { code: change.code }
        );
    }
    return { ok: true, change: await getCanonicalAdminRoleChange(db, change.code) };
}

async function undoCanonicalAdminRoleChange(
    db,
    code,
    actorId,
    reason,
    options = {}
) {
    const actor = await assertOwnerAccess(db, actorId, options);
    await ensureCanonicalAdminTeamSchema(db);
    const undoReason = requiredText(reason, 'Motivo do desfazimento');
    const change = await getCanonicalAdminRoleChange(db, code);
    if (change.status !== 'applied' || !change.appliedState) {
        throw new CanonicalAdminTeamError(
            'Somente alterações aplicadas podem ser desfeitas.',
            'admin_role_change_not_applied',
            409,
            { code: change.code, status: change.status }
        );
    }
    const now = options.now instanceof Date
        ? options.now
        : new Date(options.now || Date.now());

    await db.exec('BEGIN IMMEDIATE');
    try {
        const current = await readAdminRoleStateUnchecked(
            db,
            change.targetId,
            options.referenceDate || now
        );
        if (stateFingerprint(current) !== stateFingerprint(change.appliedState)) {
            throw new CanonicalAdminTeamError(
                'O cargo recebeu outra alteração depois desta ação.',
                'admin_role_changed_after_apply',
                409,
                { current, expected: change.appliedState }
            );
        }
        const previousRole = change.before.parity === 'matched'
            ? change.before.effectiveRoles[0]
            : null;
        await applyDesiredRoleStateInTransaction(
            db,
            current,
            previousRole,
            actor.id,
            undoReason,
            change.code,
            { undo: true, originalAction: change.action }
        );
        const restored = await readAdminRoleStateUnchecked(
            db,
            change.targetId,
            options.referenceDate || now
        );
        const expected = plannedAfterState(
            change.targetId,
            previousRole ? 'set' : 'revoke',
            previousRole
        );
        if (!stateMatchesPlanned(restored, expected)) {
            throw new CanonicalAdminTeamError(
                'A pós-condição do desfazimento não foi confirmada.',
                'admin_role_undo_postcondition_failed',
                409,
                { restored, expected }
            );
        }
        const updated = await db.run(
            `UPDATE clover_canonical_admin_role_changes
             SET status = 'undone',
                 undone_at = ?,
                 undone_by = ?,
                 undo_reason = ?
             WHERE code = ? AND status = 'applied'`,
            [now.toISOString(), actor.id, undoReason, change.code]
        );
        if (Number(updated.changes || 0) !== 1) {
            throw new CanonicalAdminTeamError(
                'A alteração mudou durante o desfazimento.',
                'admin_role_change_claim_conflict',
                409,
                { code: change.code }
            );
        }
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
    return {
        ok: true,
        change: await getCanonicalAdminRoleChange(db, change.code),
        state: await readAdminRoleState(db, change.targetId, options),
    };
}

module.exports = {
    ADMIN_ROLE_KEYS,
    CHANGE_ACTIONS,
    CHANGE_STATUSES,
    CanonicalAdminTeamError,
    applyCanonicalAdminRoleChange,
    cancelCanonicalAdminRoleChange,
    createCanonicalAdminRoleChange,
    ensureCanonicalAdminTeamSchema,
    getCanonicalAdminRoleChange,
    listCanonicalAdminRoleChanges,
    listCanonicalAdminTeam,
    maskIdentity,
    readAdminRoleState,
    stateFingerprint,
    undoCanonicalAdminRoleChange,
};
