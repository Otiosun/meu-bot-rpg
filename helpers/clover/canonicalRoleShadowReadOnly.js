'use strict';

const { isOwner, normalizeJid } = require('../groupAccess');
const { getRoleCapabilities } = require('./adminOperationContract');
const { ROLE_DEFINITIONS } = require('./accessControlService');
const { permissionScopeMap } = require('./canonicalRoleDefinitions');
const { grantIdentity, isGrantActiveAt, rowToGrant } = require('./canonicalRoleGrantSchema');
const {
    detectLegacyRoleConflicts,
    readLegacyAccessGrants,
    readLegacyAdminGrants,
    tableExists,
} = require('./canonicalRoleGrantLegacy');

function uniqueSorted(values) {
    return [...new Set((values || []).filter(Boolean))].sort();
}

function legacyRoleGrantsPermission(roleKey, permission) {
    const definition = ROLE_DEFINITIONS[roleKey];
    if (!definition) return false;
    return definition.permissions.includes('*') || definition.permissions.includes(permission);
}

async function readCanonicalGrantsReadOnly(db, options = {}) {
    if (!await tableExists(db, 'clover_role_grants')) return [];
    const params = [];
    const where = ["status = 'active'"];
    if (options.subjectId) {
        where.push('subject_id = ?');
        params.push(normalizeJid(options.subjectId));
    }
    const rows = await db.all(
        `SELECT * FROM clover_role_grants
         WHERE ${where.join(' AND ')}
         ORDER BY subject_id, role_key, scope_type, scope_key, id`,
        params
    );
    const referenceDate = options.referenceDate || new Date();
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

async function readLegacyAdminAccessReadOnly(db, subjectId, options = {}) {
    const subject = normalizeJid(subjectId);
    const owner = (options.ownerCheck || isOwner)(subject);
    if (owner) {
        return {
            ok: true,
            actor: {
                id: subject,
                role: 'owner',
                capabilities: ['*'],
                source: 'owner_config',
            },
        };
    }

    const grants = await readLegacyAdminGrants(db, subject);
    if (!grants.length) return { ok: false, code: 'admin_access_denied', actorId: subject };
    const roleKeys = uniqueSorted(grants.map((grant) => grant.roleKey));
    const role = roleKeys.length === 1 ? roleKeys[0] : null;
    const capabilities = uniqueSorted(roleKeys.flatMap((roleKey) => {
        try {
            return getRoleCapabilities(roleKey);
        } catch {
            return [];
        }
    }));
    return {
        ok: Boolean(role),
        code: role ? null : 'ambiguous_legacy_admin_role',
        actor: {
            id: subject,
            role,
            roleKeys,
            capabilities,
            source: 'legacy_admin_roles',
        },
    };
}

async function readLegacyAccessContextReadOnly(db, subjectId, options = {}) {
    const subject = normalizeJid(subjectId);
    const owner = (options.ownerCheck || isOwner)(subject);
    const grants = await readLegacyAccessGrants(db, subject);
    const permissions = new Set();
    const squadScopes = new Set();
    for (const grant of grants) {
        const definition = ROLE_DEFINITIONS[grant.roleKey];
        for (const permission of definition?.permissions || []) permissions.add(permission);
        if (grant.scopeType === 'squad' && grant.scopeKey) squadScopes.add(grant.scopeKey);
    }
    if (owner) permissions.add('*');
    return {
        actorId: subject,
        owner,
        assignments: grants.map((grant) => ({
            id: grant.id,
            subject_id: grant.subjectId,
            role_key: grant.roleKey,
            scope_type: grant.scopeType,
            scope_key: grant.scopeKey,
            status: grant.status,
            source: grant.source,
        })),
        roleKeys: uniqueSorted(grants.map((grant) => grant.roleKey)),
        permissions: uniqueSorted([...permissions]),
        squadScopes: uniqueSorted([...squadScopes]),
    };
}

async function readCanonicalRoleContextReadOnly(db, subjectId, options = {}) {
    const subject = normalizeJid(subjectId);
    const owner = (options.ownerCheck || isOwner)(subject);
    const referenceDate = options.referenceDate || new Date();
    const canonical = await readCanonicalGrantsReadOnly(db, { subjectId: subject, referenceDate });
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
        observedRoleKeys: uniqueSorted(grants.map((grant) => grant.roleKey)),
        roleKeys: uniqueSorted(effectiveGrants.map((grant) => grant.roleKey)),
        permissionScopes: permissionScopeMap(effectiveGrants, owner),
        conflicts,
        blockedByConflict: conflicts.length > 0,
        sources: uniqueSorted(grants.map((grant) => grant.source)),
    };
}

async function listRoleShadowSubjectsReadOnly(db) {
    const subjects = [];
    const sources = [
        ['clover_admin_roles', 'player_id'],
        ['clover_access_roles', 'subject_id'],
        ['clover_role_grants', 'subject_id'],
    ];
    for (const [tableName, columnName] of sources) {
        if (!await tableExists(db, tableName)) continue;
        const rows = await db.all(`SELECT ${columnName} AS subject_id FROM ${tableName}`);
        for (const row of rows || []) subjects.push(normalizeJid(row.subject_id));
    }
    return uniqueSorted(subjects);
}

module.exports = {
    legacyRoleGrantsPermission,
    listRoleShadowSubjectsReadOnly,
    mergeGrantSources,
    readCanonicalGrantsReadOnly,
    readCanonicalRoleContextReadOnly,
    readLegacyAccessContextReadOnly,
    readLegacyAdminAccessReadOnly,
    uniqueSorted,
};
