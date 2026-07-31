'use strict';

const { isOwner, normalizeJid } = require('../groupAccess');
const { normalizeSquadKey } = require('./cavalierService');
const {
    CANONICAL_ROLE_DEFINITIONS,
    CANONICAL_ROLE_KEYS,
    CanonicalRoleGrantError,
    getCanonicalRoleDefinition,
    normalizeScope,
    permissionScopeMap,
    resolveCanonicalRoleKey,
} = require('./canonicalRoleDefinitions');
const {
    ensureCanonicalRoleGrantSchema,
    grantIdentity,
    isGrantActiveAt,
    rowToGrant,
    serializeMetadata,
} = require('./canonicalRoleGrantSchema');
const {
    detectLegacyRoleConflicts,
    planLegacyRoleMigration: buildLegacyMigrationPlan,
    readLegacyAccessGrants,
    readLegacyAdminGrants,
} = require('./canonicalRoleGrantLegacy');

function normalizedSubject(value) {
    const subject = normalizeJid(value);
    if (!subject) {
        throw new CanonicalRoleGrantError('Identidade inválida.', 'invalid_subject', { subjectId: value });
    }
    return subject;
}

async function readCanonicalGrants(db, { subjectId = null, referenceDate = new Date() } = {}) {
    await ensureCanonicalRoleGrantSchema(db);
    const params = [];
    const where = ["status = 'active'"];
    if (subjectId) {
        where.push('subject_id = ?');
        params.push(normalizeJid(subjectId));
    }
    const rows = await db.all(
        `SELECT * FROM clover_role_grants
         WHERE ${where.join(' AND ')}
         ORDER BY subject_id, role_key, scope_type, scope_key, id`,
        params
    );
    return (rows || [])
        .map((row) => rowToGrant(row, 'canonical'))
        .filter((grant) => isGrantActiveAt(grant, referenceDate));
}

function mergeGrantSources(canonical, legacy) {
    const merged = [];
    const seen = new Set();
    for (const grant of [...canonical, ...legacy]) {
        const key = grantIdentity(grant);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(grant);
    }
    return merged;
}

async function getCanonicalRoleContext(db, subjectId, options = {}) {
    const subject = normalizedSubject(subjectId);
    const owner = (options.ownerCheck || isOwner)(subject);
    const referenceDate = options.referenceDate || new Date();
    const canonical = await readCanonicalGrants(db, { subjectId: subject, referenceDate });
    const legacy = options.includeLegacy === false
        ? []
        : [
            ...await readLegacyAdminGrants(db, subject),
            ...await readLegacyAccessGrants(db, subject),
        ];
    const conflicts = detectLegacyRoleConflicts(legacy);
    const grants = mergeGrantSources(canonical, legacy);
    const conflictingSubjects = new Set(conflicts.map((conflict) => conflict.subjectId));
    const effectiveGrants = grants.filter((grant) => (
        grant.source === 'canonical'
        || grant.scopeType !== 'global'
        || !conflictingSubjects.has(grant.subjectId)
    ));

    if (owner) {
        const ownerGrant = {
            id: null,
            subjectId: subject,
            roleKey: 'owner',
            scopeType: 'global',
            scopeKey: '*',
            status: 'active',
            validFrom: null,
            validUntil: null,
            grantedBy: 'owner_config',
            reason: null,
            originType: 'owner_config',
            originRef: null,
            metadata: {},
            source: 'owner_config',
        };
        grants.unshift(ownerGrant);
        effectiveGrants.unshift(ownerGrant);
    }

    return {
        subjectId: subject,
        owner,
        grants,
        observedRoleKeys: [...new Set(grants.map((grant) => grant.roleKey))],
        roleKeys: [...new Set(effectiveGrants.map((grant) => grant.roleKey))],
        permissionScopes: permissionScopeMap(effectiveGrants, owner),
        conflicts,
        blockedByConflict: conflicts.length > 0 && effectiveGrants.length === 0,
        sources: [...new Set(grants.map((grant) => grant.source))],
    };
}

function contextHasCanonicalPermission(context, permission, scopeKey = null) {
    if (!context || !permission) return false;
    if (context.owner) return true;
    const wildcard = context.permissionScopes?.['*'];
    if (wildcard?.global) return true;
    const scope = context.permissionScopes?.[permission];
    if (!scope) return false;
    if (scope.global) return true;
    if (!scopeKey) return false;
    return scope.squads.includes(normalizeSquadKey(scopeKey));
}

async function planLegacyRoleMigration(db, options = {}) {
    const canonical = await readCanonicalGrants(db, {
        referenceDate: options.referenceDate || new Date(),
    });
    return buildLegacyMigrationPlan(db, canonical, options);
}

async function writeGrantEvent(db, grant, action, actor, reason, payload = {}) {
    await db.run(
        `INSERT INTO clover_role_grant_events
         (grant_id, subject_id, role_key, scope_type, scope_key, action,
          performed_by, reason, origin_type, origin_ref, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            grant.id || null,
            grant.subject_id,
            grant.role_key,
            grant.scope_type,
            grant.scope_key,
            action,
            normalizeJid(actor) || String(actor || 'system'),
            String(reason || '').trim() || null,
            grant.origin_type || null,
            grant.origin_ref || null,
            serializeMetadata(payload),
        ]
    );
}

function validateGrantValidity(input) {
    const validFrom = input.validFrom ? new Date(input.validFrom) : null;
    const validUntil = input.validUntil ? new Date(input.validUntil) : null;
    if ((validFrom && Number.isNaN(validFrom.getTime()))
        || (validUntil && Number.isNaN(validUntil.getTime()))
        || (validFrom && validUntil && validUntil <= validFrom)) {
        throw new CanonicalRoleGrantError(
            'Período de validade do cargo é inválido.',
            'invalid_grant_validity',
            { validFrom: input.validFrom || null, validUntil: input.validUntil || null }
        );
    }
    return { validFrom, validUntil };
}

async function grantCanonicalRole(db, input) {
    await ensureCanonicalRoleGrantSchema(db);
    const subject = normalizedSubject(input.subjectId);
    const actor = normalizeJid(input.grantedBy) || String(input.grantedBy || '').trim();
    if (!actor) throw new CanonicalRoleGrantError('Ator inválido.', 'invalid_actor');
    const definition = getCanonicalRoleDefinition(input.role);
    if (definition?.key === 'owner') {
        throw new CanonicalRoleGrantError(
            'O Proprietário é definido pela configuração e não pode ser concedido manualmente.',
            'owner_role_not_assignable'
        );
    }
    const scope = normalizeScope(definition, input.scopeKey);
    const { validFrom, validUntil } = validateGrantValidity(input);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const existing = await db.get(
            `SELECT * FROM clover_role_grants
             WHERE subject_id = ? AND role_key = ? AND scope_type = ? AND scope_key = ?
               AND status = 'active'`,
            [subject, definition.key, scope.scopeType, scope.scopeKey]
        );
        if (existing) {
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, grant: rowToGrant(existing) };
        }

        const result = await db.run(
            `INSERT INTO clover_role_grants
             (subject_id, role_key, scope_type, scope_key, status, valid_from, valid_until,
              granted_by, grant_reason, origin_type, origin_ref, metadata_json)
             VALUES (?, ?, ?, ?, 'active', COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?, ?, ?)`,
            [
                subject,
                definition.key,
                scope.scopeType,
                scope.scopeKey,
                validFrom ? validFrom.toISOString() : null,
                validUntil ? validUntil.toISOString() : null,
                actor,
                String(input.reason || '').trim() || null,
                String(input.originType || 'manual'),
                input.originRef ? String(input.originRef) : null,
                serializeMetadata(input.metadata || {}),
            ]
        );
        const grant = await db.get('SELECT * FROM clover_role_grants WHERE id = ?', [result.lastID]);
        await writeGrantEvent(db, grant, 'granted', actor, input.reason, input.metadata || {});
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, grant: rowToGrant(grant) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function revokeCanonicalRole(db, input) {
    await ensureCanonicalRoleGrantSchema(db);
    const subject = normalizedSubject(input.subjectId);
    const actor = normalizeJid(input.revokedBy) || String(input.revokedBy || '').trim();
    if (!actor) throw new CanonicalRoleGrantError('Ator inválido.', 'invalid_actor');
    const definition = getCanonicalRoleDefinition(input.role);
    if (definition?.key === 'owner') {
        throw new CanonicalRoleGrantError(
            'O Proprietário não pode ser revogado pelo banco.',
            'owner_role_not_revocable'
        );
    }
    const scope = normalizeScope(definition, input.scopeKey);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const grants = await db.all(
            `SELECT * FROM clover_role_grants
             WHERE subject_id = ? AND role_key = ? AND scope_type = ? AND scope_key = ?
               AND status = 'active'
             ORDER BY id`,
            [subject, definition.key, scope.scopeType, scope.scopeKey]
        );
        if (!grants.length) {
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, revoked: [] };
        }
        for (const grant of grants) {
            const updated = await db.run(
                `UPDATE clover_role_grants
                 SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, revoked_by = ?,
                     revoke_reason = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = 'active'`,
                [actor, String(input.reason || '').trim() || null, grant.id]
            );
            if (Number(updated.changes || 0) === 1) {
                await writeGrantEvent(db, grant, 'revoked', actor, input.reason, input.metadata || {});
            }
        }
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, revoked: grants.map((grant) => rowToGrant(grant)) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    CANONICAL_ROLE_DEFINITIONS,
    CANONICAL_ROLE_KEYS,
    CanonicalRoleGrantError,
    contextHasCanonicalPermission,
    detectLegacyRoleConflicts,
    ensureCanonicalRoleGrantSchema,
    getCanonicalRoleContext,
    getCanonicalRoleDefinition,
    grantCanonicalRole,
    isGrantActiveAt,
    normalizeScope,
    planLegacyRoleMigration,
    readCanonicalGrants,
    readLegacyAccessGrants,
    readLegacyAdminGrants,
    resolveCanonicalRoleKey,
    revokeCanonicalRole,
};
