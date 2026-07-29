'use strict';

const {
    isOwner,
    isSameUser,
    normalizeJid,
} = require('../groupAccess');
const { normalizeText } = require('../textUtils');
const { normalizeSquadKey } = require('./cavalierService');

const ACCESS_ROLE_KEYS = Object.freeze([
    'admin',
    'narrator',
    'evaluator',
    'captain',
    'vice_captain',
]);

const CHARACTER_READ_PERMISSIONS = Object.freeze([
    'character.read.profile',
    'character.read.progress',
    'character.read.capacity',
    'character.read.grimoire',
]);

const ROLE_DEFINITIONS = Object.freeze({
    admin: Object.freeze({
        key: 'admin',
        label: 'Administrador',
        scopeType: 'global',
        permissions: Object.freeze(['*']),
    }),
    narrator: Object.freeze({
        key: 'narrator',
        label: 'Narrador',
        scopeType: 'global',
        permissions: Object.freeze([
            ...CHARACTER_READ_PERMISSIONS,
            'squad.read.state',
            'squad.read.members',
            'squad.read.resources',
            'raid.create',
            'raid.read.all',
            'raid.manage',
        ]),
    }),
    evaluator: Object.freeze({
        key: 'evaluator',
        label: 'Avaliador',
        scopeType: 'global',
        permissions: Object.freeze([
            ...CHARACTER_READ_PERMISSIONS,
            'evaluation.apply',
            'raid.reward.review',
        ]),
    }),
    captain: Object.freeze({
        key: 'captain',
        label: 'Capitão',
        scopeType: 'squad',
        permissions: Object.freeze([
            ...CHARACTER_READ_PERMISSIONS,
            'squad.read.state',
            'squad.read.members',
            'squad.read.resources',
            'squad.manage.members',
            'raid.create',
            'raid.manage',
        ]),
    }),
    vice_captain: Object.freeze({
        key: 'vice_captain',
        label: 'Vice-Capitão',
        scopeType: 'squad',
        permissions: Object.freeze([
            ...CHARACTER_READ_PERMISSIONS,
            'squad.read.state',
            'squad.read.members',
            'squad.read.resources',
        ]),
    }),
});

const ROLE_ALIASES = Object.freeze({
    adm: 'admin',
    admin: 'admin',
    administrador: 'admin',
    administradora: 'admin',
    narrador: 'narrator',
    narradora: 'narrator',
    narrativa: 'narrator',
    evaluator: 'evaluator',
    avaliador: 'evaluator',
    avaliadora: 'evaluator',
    capitao: 'captain',
    capita: 'captain',
    captain: 'captain',
    vice: 'vice_captain',
    vicecapitao: 'vice_captain',
    vicecapita: 'vice_captain',
    vicecaptain: 'vice_captain',
});

function normalizeRoleToken(value) {
    return normalizeText(value || '')
        .replace(/[^a-z0-9]+/g, '')
        .trim();
}

function resolveRoleKey(value) {
    const compact = normalizeRoleToken(value);
    return ROLE_ALIASES[compact] || (ACCESS_ROLE_KEYS.includes(compact) ? compact : null);
}

function getRoleDefinition(value) {
    const roleKey = resolveRoleKey(value);
    return roleKey ? ROLE_DEFINITIONS[roleKey] : null;
}

function normalizeScopeKey(value) {
    return normalizeSquadKey(value);
}

function safeJsonParse(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function serializeMetadata(value) {
    if (!value || typeof value !== 'object') return null;
    return JSON.stringify(value);
}

async function ensureAccessControlSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_access_roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_id TEXT NOT NULL,
            role_key TEXT NOT NULL
                CHECK (role_key IN ('admin', 'narrator', 'evaluator', 'captain', 'vice_captain')),
            scope_type TEXT NOT NULL
                CHECK (scope_type IN ('global', 'squad')),
            scope_key TEXT NOT NULL DEFAULT '*',
            status TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'revoked')),
            assigned_by TEXT NOT NULL,
            reason TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            revoked_at TEXT DEFAULT NULL,
            revoked_by TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_access_roles_active_unique
        ON clover_access_roles (subject_id, role_key, scope_type, scope_key)
        WHERE status = 'active'
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_access_roles_subject_active
        ON clover_access_roles (subject_id, status, role_key)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_access_roles_scope_active
        ON clover_access_roles (scope_type, scope_key, status, role_key)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_access_role_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            assignment_id INTEGER DEFAULT NULL,
            subject_id TEXT NOT NULL,
            role_key TEXT NOT NULL,
            scope_type TEXT NOT NULL,
            scope_key TEXT NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('assigned', 'revoked')),
            performed_by TEXT NOT NULL,
            reason TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_access_role_events_subject
        ON clover_access_role_events (subject_id, created_at DESC, id DESC)
    `);
}

function resolveAssignmentScope(roleDefinition, scopeKey) {
    if (!roleDefinition) return { ok: false, code: 'unknown_role' };
    if (roleDefinition.scopeType === 'global') {
        return { ok: true, scopeType: 'global', scopeKey: '*' };
    }

    const normalized = normalizeScopeKey(scopeKey);
    if (!normalized) return { ok: false, code: 'squad_required' };
    return { ok: true, scopeType: 'squad', scopeKey: normalized };
}

async function writeRoleEvent(db, assignment, action, performedBy, reason, metadata = {}) {
    await db.run(
        `INSERT INTO clover_access_role_events
         (assignment_id, subject_id, role_key, scope_type, scope_key,
          action, performed_by, reason, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            assignment?.id || null,
            assignment.subject_id,
            assignment.role_key,
            assignment.scope_type,
            assignment.scope_key,
            action,
            normalizeJid(performedBy) || String(performedBy || 'system'),
            String(reason || '').trim() || null,
            serializeMetadata(metadata),
        ]
    );
}

async function assignAccessRole(db, {
    subjectId,
    role,
    scopeKey = null,
    assignedBy,
    reason = null,
    metadata = {},
}) {
    await ensureAccessControlSchema(db);
    const subject = normalizeJid(subjectId);
    const actor = normalizeJid(assignedBy) || String(assignedBy || '').trim();
    const definition = getRoleDefinition(role);
    if (!subject) return { ok: false, code: 'invalid_subject' };
    if (!actor) return { ok: false, code: 'invalid_actor' };
    if (!definition) return { ok: false, code: 'unknown_role' };

    const scope = resolveAssignmentScope(definition, scopeKey);
    if (!scope.ok) return { ...scope, role: definition };

    const existing = await db.get(
        `SELECT * FROM clover_access_roles
         WHERE subject_id = ?
           AND role_key = ?
           AND scope_type = ?
           AND scope_key = ?
           AND status = 'active'`,
        [subject, definition.key, scope.scopeType, scope.scopeKey]
    );
    if (existing) {
        return {
            ok: true,
            code: 'already_active',
            inserted: false,
            assignment: existing,
            role: definition,
        };
    }

    const result = await db.run(
        `INSERT INTO clover_access_roles
         (subject_id, role_key, scope_type, scope_key, status,
          assigned_by, reason, metadata_json)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
        [
            subject,
            definition.key,
            scope.scopeType,
            scope.scopeKey,
            actor,
            String(reason || '').trim() || null,
            serializeMetadata(metadata),
        ]
    );
    const assignment = await db.get('SELECT * FROM clover_access_roles WHERE id = ?', [result.lastID]);
    await writeRoleEvent(db, assignment, 'assigned', actor, reason, metadata);

    return {
        ok: true,
        code: 'assigned',
        inserted: true,
        assignment,
        role: definition,
    };
}

async function revokeAccessRole(db, {
    subjectId,
    role,
    scopeKey = null,
    revokedBy,
    reason = null,
    metadata = {},
}) {
    await ensureAccessControlSchema(db);
    const subject = normalizeJid(subjectId);
    const actor = normalizeJid(revokedBy) || String(revokedBy || '').trim();
    const definition = getRoleDefinition(role);
    if (!subject) return { ok: false, code: 'invalid_subject' };
    if (!actor) return { ok: false, code: 'invalid_actor' };
    if (!definition) return { ok: false, code: 'unknown_role' };

    const params = [subject, definition.key];
    let scopeWhere = '';
    if (definition.scopeType === 'global') {
        scopeWhere = " AND scope_type = 'global' AND scope_key = '*'";
    } else if (scopeKey) {
        const normalizedScope = normalizeScopeKey(scopeKey);
        if (!normalizedScope) return { ok: false, code: 'squad_required', role: definition };
        scopeWhere = " AND scope_type = 'squad' AND scope_key = ?";
        params.push(normalizedScope);
    } else {
        scopeWhere = " AND scope_type = 'squad'";
    }

    const assignments = await db.all(
        `SELECT * FROM clover_access_roles
         WHERE subject_id = ?
           AND role_key = ?
           AND status = 'active'
           ${scopeWhere}
         ORDER BY id ASC`,
        params
    );
    if (!assignments.length) {
        return { ok: false, code: 'not_active', role: definition, revoked: [] };
    }

    for (const assignment of assignments) {
        await db.run(
            `UPDATE clover_access_roles
             SET status = 'revoked',
                 revoked_at = CURRENT_TIMESTAMP,
                 revoked_by = ?
             WHERE id = ?
               AND status = 'active'`,
            [actor, assignment.id]
        );
        await writeRoleEvent(db, assignment, 'revoked', actor, reason, metadata);
    }

    return {
        ok: true,
        code: 'revoked',
        role: definition,
        revoked: assignments,
    };
}

async function listActiveAccessRoles(db, { subjectId = null, role = null } = {}) {
    await ensureAccessControlSchema(db);
    const params = [];
    const where = ["status = 'active'"];

    if (subjectId) {
        where.push('subject_id = ?');
        params.push(normalizeJid(subjectId));
    }
    if (role) {
        const roleKey = resolveRoleKey(role);
        if (!roleKey) return [];
        where.push('role_key = ?');
        params.push(roleKey);
    }

    return db.all(
        `SELECT * FROM clover_access_roles
         WHERE ${where.join(' AND ')}
         ORDER BY role_key ASC, scope_key ASC, created_at ASC, id ASC`,
        params
    );
}

async function listAccessRoleEvents(db, { subjectId = null, limit = 30 } = {}) {
    await ensureAccessControlSchema(db);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
    if (subjectId) {
        return db.all(
            `SELECT * FROM clover_access_role_events
             WHERE subject_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
            [normalizeJid(subjectId), safeLimit]
        );
    }
    return db.all(
        `SELECT * FROM clover_access_role_events
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [safeLimit]
    );
}

function roleGrantsPermission(roleKey, permission) {
    const definition = ROLE_DEFINITIONS[roleKey];
    if (!definition) return false;
    return definition.permissions.includes('*') || definition.permissions.includes(permission);
}

function isOwnCharacterReadPermission(permission) {
    return CHARACTER_READ_PERMISSIONS.includes(permission);
}

async function getAccessContext(db, actorId) {
    await ensureAccessControlSchema(db);
    const normalizedActor = normalizeJid(actorId);
    const owner = isOwner(normalizedActor);
    const assignments = normalizedActor
        ? await listActiveAccessRoles(db, { subjectId: normalizedActor })
        : [];
    const permissions = new Set();
    const squadScopes = new Set();

    for (const assignment of assignments) {
        const definition = ROLE_DEFINITIONS[assignment.role_key];
        for (const permission of definition?.permissions || []) permissions.add(permission);
        if (assignment.scope_type === 'squad' && assignment.scope_key) squadScopes.add(assignment.scope_key);
    }
    if (owner) permissions.add('*');

    return {
        actorId: normalizedActor,
        owner,
        assignments: assignments.map((assignment) => ({
            ...assignment,
            metadata: safeJsonParse(assignment.metadata_json, {}),
            role: ROLE_DEFINITIONS[assignment.role_key] || null,
        })),
        roleKeys: [...new Set(assignments.map((assignment) => assignment.role_key))],
        permissions: [...permissions],
        squadScopes: [...squadScopes],
    };
}

function contextHasPermission(context, permission) {
    if (!context) return false;
    if (context.owner) return true;
    if (context.permissions?.includes('*')) return true;
    return context.permissions?.includes(permission) || false;
}

async function hasAccessPermission(db, actorId, permission) {
    return contextHasPermission(await getAccessContext(db, actorId), permission);
}

async function authorizeTargetAccess(db, {
    actorId,
    targetPlayer,
    permission,
}) {
    const actor = normalizeJid(actorId);
    const targetId = normalizeJid(targetPlayer?.id || targetPlayer?.player_id);
    if (!actor || !targetId || !permission) {
        return { ok: false, code: 'invalid_request', actorId: actor, targetId };
    }

    if (isOwner(actor)) {
        return { ok: true, code: 'owner', actorId: actor, targetId, permission };
    }
    if (isSameUser(actor, targetId) && isOwnCharacterReadPermission(permission)) {
        return { ok: true, code: 'self', actorId: actor, targetId, permission };
    }

    const context = await getAccessContext(db, actor);
    for (const assignment of context.assignments) {
        if (!roleGrantsPermission(assignment.role_key, permission)) continue;
        if (assignment.scope_type === 'global') {
            return {
                ok: true,
                code: 'global_role',
                actorId: actor,
                targetId,
                permission,
                assignment,
            };
        }
        if (assignment.scope_type === 'squad') {
            const targetSquadKey = normalizeScopeKey(targetPlayer?.esquadrao || targetPlayer?.squad_key);
            if (targetSquadKey && targetSquadKey === assignment.scope_key) {
                return {
                    ok: true,
                    code: 'squad_role',
                    actorId: actor,
                    targetId,
                    permission,
                    assignment,
                    targetSquadKey,
                };
            }
        }
    }

    return {
        ok: false,
        code: 'forbidden',
        actorId: actor,
        targetId,
        permission,
        context,
    };
}

function getRoleLabel(roleKey) {
    return ROLE_DEFINITIONS[roleKey]?.label || roleKey || '-';
}

function getScopeLabel(assignment) {
    if (!assignment) return '-';
    return assignment.scope_type === 'global' ? 'Global' : assignment.scope_key;
}

module.exports = {
    ACCESS_ROLE_KEYS,
    CHARACTER_READ_PERMISSIONS,
    ROLE_DEFINITIONS,
    assignAccessRole,
    authorizeTargetAccess,
    contextHasPermission,
    ensureAccessControlSchema,
    getAccessContext,
    getRoleDefinition,
    getRoleLabel,
    getScopeLabel,
    hasAccessPermission,
    listAccessRoleEvents,
    listActiveAccessRoles,
    normalizeRoleToken,
    normalizeScopeKey,
    resolveRoleKey,
    revokeAccessRole,
    roleGrantsPermission,
};
