'use strict';

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
    return value && typeof value === 'object' ? JSON.stringify(value) : null;
}

async function ensureCanonicalRoleGrantSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_role_grants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_id TEXT NOT NULL,
            role_key TEXT NOT NULL
                CHECK (role_key IN ('owner', 'admin', 'evaluator', 'narrator', 'assistant', 'captain', 'vice_captain')),
            scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'squad')),
            scope_key TEXT NOT NULL DEFAULT '*',
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
            valid_from TEXT DEFAULT CURRENT_TIMESTAMP,
            valid_until TEXT DEFAULT NULL,
            granted_by TEXT NOT NULL,
            grant_reason TEXT DEFAULT NULL,
            origin_type TEXT NOT NULL DEFAULT 'manual',
            origin_ref TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            revoked_at TEXT DEFAULT NULL,
            revoked_by TEXT DEFAULT NULL,
            revoke_reason TEXT DEFAULT NULL
        )
    `);
    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_role_grants_active_unique
        ON clover_role_grants (subject_id, role_key, scope_type, scope_key)
        WHERE status = 'active'
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_role_grants_subject_active
        ON clover_role_grants (subject_id, status, role_key, scope_type, scope_key)
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_role_grants_scope_active
        ON clover_role_grants (scope_type, scope_key, status, role_key)
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_role_grant_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            grant_id INTEGER DEFAULT NULL,
            subject_id TEXT NOT NULL,
            role_key TEXT NOT NULL,
            scope_type TEXT NOT NULL,
            scope_key TEXT NOT NULL,
            action TEXT NOT NULL
                CHECK (action IN ('granted', 'revoked', 'expired', 'migration_planned')),
            performed_by TEXT NOT NULL,
            reason TEXT DEFAULT NULL,
            origin_type TEXT DEFAULT NULL,
            origin_ref TEXT DEFAULT NULL,
            payload_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (grant_id) REFERENCES clover_role_grants(id)
        )
    `);
}

function rowToGrant(row, source = 'canonical') {
    if (!row) return null;
    return {
        id: row.id ?? null,
        subjectId: row.subject_id,
        roleKey: row.role_key,
        scopeType: row.scope_type,
        scopeKey: row.scope_key,
        status: row.status || 'active',
        validFrom: row.valid_from || row.created_at || null,
        validUntil: row.valid_until || null,
        grantedBy: row.granted_by || row.assigned_by || null,
        reason: row.grant_reason || row.reason || null,
        originType: row.origin_type || source,
        originRef: row.origin_ref || null,
        metadata: safeJsonParse(row.metadata_json, {}),
        source,
    };
}

function isGrantActiveAt(grant, referenceDate = new Date()) {
    if (!grant || grant.status !== 'active') return false;
    const now = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
    if (Number.isNaN(now.getTime())) return false;
    if (grant.validFrom) {
        const starts = new Date(grant.validFrom);
        if (!Number.isNaN(starts.getTime()) && starts > now) return false;
    }
    if (grant.validUntil) {
        const ends = new Date(grant.validUntil);
        if (!Number.isNaN(ends.getTime()) && ends <= now) return false;
    }
    return true;
}

function grantIdentity(grant) {
    return [grant.subjectId, grant.roleKey, grant.scopeType, grant.scopeKey].join('|');
}

module.exports = {
    ensureCanonicalRoleGrantSchema,
    grantIdentity,
    isGrantActiveAt,
    rowToGrant,
    safeJsonParse,
    serializeMetadata,
};
