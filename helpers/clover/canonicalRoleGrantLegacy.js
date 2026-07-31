'use strict';

const { normalizeJid } = require('../groupAccess');
const {
    getCanonicalRoleDefinition,
    normalizeScope,
} = require('./canonicalRoleDefinitions');
const {
    grantIdentity,
    safeJsonParse,
} = require('./canonicalRoleGrantSchema');

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tableName]
    );
    return Boolean(row?.found);
}

async function readLegacyAdminGrants(db, subjectId = null) {
    if (!await tableExists(db, 'clover_admin_roles')) return [];
    const params = [];
    let where = 'WHERE active = 1';
    if (subjectId) {
        where += ' AND player_id = ?';
        params.push(normalizeJid(subjectId));
    }
    const rows = await db.all(
        `SELECT player_id, role, granted_by, granted_at, updated_at
         FROM clover_admin_roles ${where}
         ORDER BY player_id, role`,
        params
    );
    return (rows || []).flatMap((row) => {
        const definition = getCanonicalRoleDefinition(row.role);
        if (!definition || !['admin', 'evaluator', 'narrator', 'assistant'].includes(definition.key)) return [];
        return [{
            id: null,
            subjectId: normalizeJid(row.player_id),
            roleKey: definition.key,
            scopeType: 'global',
            scopeKey: '*',
            status: 'active',
            validFrom: row.granted_at || null,
            validUntil: null,
            grantedBy: row.granted_by || null,
            reason: null,
            originType: 'legacy_admin_roles',
            originRef: null,
            metadata: { legacy_updated_at: row.updated_at || null },
            source: 'legacy_admin_roles',
        }];
    });
}

async function readLegacyAccessGrants(db, subjectId = null) {
    if (!await tableExists(db, 'clover_access_roles')) return [];
    const params = [];
    let where = "WHERE status = 'active'";
    if (subjectId) {
        where += ' AND subject_id = ?';
        params.push(normalizeJid(subjectId));
    }
    const rows = await db.all(
        `SELECT * FROM clover_access_roles ${where}
         ORDER BY subject_id, role_key, scope_type, scope_key, id`,
        params
    );
    return (rows || []).flatMap((row) => {
        const definition = getCanonicalRoleDefinition(row.role_key);
        if (!definition) return [];
        let scope;
        try {
            scope = normalizeScope(definition, row.scope_key);
        } catch {
            return [];
        }
        return [{
            id: row.id,
            subjectId: normalizeJid(row.subject_id),
            roleKey: definition.key,
            scopeType: scope.scopeType,
            scopeKey: scope.scopeKey,
            status: 'active',
            validFrom: row.created_at || null,
            validUntil: null,
            grantedBy: row.assigned_by || null,
            reason: row.reason || null,
            originType: 'legacy_access_roles',
            originRef: String(row.id),
            metadata: safeJsonParse(row.metadata_json, {}),
            source: 'legacy_access_roles',
        }];
    });
}

function detectLegacyRoleConflicts(grants) {
    const bySubject = new Map();
    for (const grant of grants || []) {
        if (!grant.subjectId || grant.scopeType !== 'global') continue;
        if (!bySubject.has(grant.subjectId)) bySubject.set(grant.subjectId, []);
        bySubject.get(grant.subjectId).push(grant);
    }
    const conflicts = [];
    for (const [subjectId, subjectGrants] of bySubject.entries()) {
        const adminSources = subjectGrants.filter((grant) => grant.source === 'legacy_admin_roles');
        const accessSources = subjectGrants.filter((grant) => grant.source === 'legacy_access_roles');
        if (!adminSources.length || !accessSources.length) continue;
        const adminRoles = [...new Set(adminSources.map((grant) => grant.roleKey))].sort();
        const accessRoles = [...new Set(accessSources.map((grant) => grant.roleKey))].sort();
        if (JSON.stringify(adminRoles) !== JSON.stringify(accessRoles)) {
            conflicts.push({
                code: 'legacy_global_role_divergence',
                subjectId,
                adminRoles,
                accessRoles,
            });
        }
    }
    return conflicts;
}

async function planLegacyRoleMigration(db, canonical, options = {}) {
    const legacy = [
        ...await readLegacyAdminGrants(db),
        ...await readLegacyAccessGrants(db),
    ];
    const canonicalKeys = new Set((canonical || []).map(grantIdentity));
    const planned = [];
    const seen = new Set();
    for (const grant of legacy) {
        const key = grantIdentity(grant);
        if (canonicalKeys.has(key) || seen.has(key)) continue;
        seen.add(key);
        planned.push({
            subjectId: grant.subjectId,
            roleKey: grant.roleKey,
            scopeType: grant.scopeType,
            scopeKey: grant.scopeKey,
            grantedBy: grant.grantedBy || 'migration',
            reason: grant.reason,
            originType: grant.originType,
            originRef: grant.originRef,
            metadata: grant.metadata,
        });
    }
    return {
        ok: true,
        write: false,
        canonicalCount: (canonical || []).length,
        legacyCount: legacy.length,
        plannedCount: planned.length,
        planned,
        conflicts: detectLegacyRoleConflicts(legacy),
        referenceDate: options.referenceDate || null,
    };
}

module.exports = {
    detectLegacyRoleConflicts,
    planLegacyRoleMigration,
    readLegacyAccessGrants,
    readLegacyAdminGrants,
    tableExists,
};
