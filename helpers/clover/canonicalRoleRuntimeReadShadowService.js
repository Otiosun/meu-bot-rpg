'use strict';

const { normalizeJid } = require('../groupAccess');
const { normalizeSquadKey } = require('./cavalierService');
const {
    ADMIN_ROLES,
    getRoleCapabilities,
} = require('./adminOperationContract');
const {
    CHARACTER_READ_PERMISSIONS,
    ROLE_DEFINITIONS,
} = require('./accessControlService');
const {
    CANONICAL_ROLE_DEFINITIONS,
} = require('./canonicalRoleDefinitions');
const {
    tableExists,
} = require('./canonicalRoleGrantLegacy');
const {
    listRoleShadowSubjectsReadOnly,
    readCanonicalRoleContextReadOnly,
    readLegacyAccessContextReadOnly,
    readLegacyAdminAccessReadOnly,
} = require('./canonicalRoleShadowReadOnly');
const {
    ROLE_POLICY_VERSION,
    approvedPolicyDelta,
    canonicalPermission,
    legacyAdminPermission,
    legacyGenericPermission,
    legacyScopedPermission,
} = require('./canonicalRoleShadowService');

const ADMIN_SURFACE_ROLES = Object.freeze([
    'owner',
    'admin',
    'evaluator',
    'narrator',
    'assistant',
]);

const ACCESS_SURFACE_ROLES = Object.freeze([
    'admin',
    'narrator',
    'evaluator',
    'captain',
    'vice_captain',
]);

class CanonicalRoleRuntimeReadShadowError extends Error {
    constructor(message, code = 'canonical_role_runtime_read_shadow_failed', details = null) {
        super(message || code);
        this.name = 'CanonicalRoleRuntimeReadShadowError';
        this.code = code;
        this.details = details;
    }
}

function uniqueSorted(values) {
    return [...new Set((values || []).filter(Boolean))].sort();
}

function permissionCatalog() {
    const canonical = Object.values(CANONICAL_ROLE_DEFINITIONS)
        .flatMap((definition) => definition.permissions || []);
    const access = Object.values(ROLE_DEFINITIONS)
        .flatMap((definition) => definition.permissions || []);
    const admin = Object.values(ADMIN_ROLES)
        .flatMap((role) => {
            try {
                return getRoleCapabilities(role);
            } catch {
                return [];
            }
        });
    return uniqueSorted([...canonical, ...access, ...admin].filter((permission) => permission !== '*'));
}

async function listKnownSquadKeysReadOnly(db) {
    if (!await tableExists(db, 'clover_squads')) return [];
    const rows = await db.all(
        `SELECT squad_key
         FROM clover_squads
         WHERE squad_key IS NOT NULL AND TRIM(squad_key) <> ''
         ORDER BY squad_key`
    );
    return uniqueSorted((rows || []).map((row) => normalizeSquadKey(row.squad_key)));
}

function canonicalAdminProjection(context) {
    if (context?.owner) {
        return {
            ok: true,
            ambiguous: false,
            role: 'owner',
            roleKeys: ['owner'],
            capabilities: uniqueSorted(getRoleCapabilities('owner')),
        };
    }

    const roleKeys = uniqueSorted((context?.roleKeys || []).filter((roleKey) => (
        ADMIN_SURFACE_ROLES.includes(roleKey) && roleKey !== 'owner'
    )));
    const role = roleKeys.length === 1 ? roleKeys[0] : null;
    const capabilities = uniqueSorted(Object.entries(context?.permissionScopes || {})
        .filter(([, scope]) => scope?.global === true)
        .map(([permission]) => permission)
        .filter((permission) => permission !== '*'));

    return {
        ok: Boolean(role),
        ambiguous: roleKeys.length > 1,
        role,
        roleKeys,
        capabilities,
    };
}

function canonicalAccessProjection(context) {
    return {
        owner: Boolean(context?.owner),
        roleKeys: uniqueSorted((context?.roleKeys || []).filter((roleKey) => (
            ACCESS_SURFACE_ROLES.includes(roleKey)
        ))),
        globalPermissions: uniqueSorted(Object.entries(context?.permissionScopes || {})
            .filter(([, scope]) => scope?.global === true)
            .map(([permission]) => permission)),
        squadScopes: uniqueSorted(Object.values(context?.permissionScopes || {})
            .flatMap((scope) => scope?.squads || [])
            .map(normalizeSquadKey)),
    };
}

function surfacePolicyDelta({
    surface,
    roleKeys,
    permission,
    scopeKey,
    direction,
}) {
    const general = approvedPolicyDelta({
        roleKeys,
        permission,
        scopeKey,
        direction,
    });

    if (!general.approved) return general;

    if (surface === 'admin') {
        return general;
    }

    if (surface === 'access') {
        if (general.roleKey === 'narrator' || general.roleKey === 'captain') {
            return general;
        }
    }

    return {
        ...general,
        approved: false,
        reason: null,
        roleKey: null,
    };
}

function classifySurfaceDecision({
    surface,
    legacy,
    canonical,
    canonicalContext,
    roleKeys,
    permission,
    scopeKey = null,
}) {
    if (legacy === canonical) {
        return {
            divergent: false,
            critical: false,
            classification: 'equivalent',
            direction: null,
            approved: false,
            policyReason: null,
        };
    }

    const canonicalScope = canonicalContext?.permissionScopes?.[permission] || null;
    if (surface === 'access_generic'
        && legacy === true
        && canonical === false
        && (canonicalScope?.squads || []).length > 0) {
        return {
            divergent: true,
            critical: true,
            classification: 'generic_scope_hardening_required',
            direction: 'restriction',
            approved: true,
            policyReason: 'scoped_permission_must_not_be_flattened',
        };
    }

    const direction = canonical ? 'expansion' : 'restriction';
    const policy = surfacePolicyDelta({
        surface: surface === 'admin' ? 'admin' : 'access',
        roleKeys,
        permission,
        scopeKey,
        direction,
    });

    return {
        divergent: true,
        critical: !policy.approved,
        classification: policy.approved
            ? `approved_${surface}_${direction}`
            : `unapproved_${surface}_${direction}`,
        direction,
        approved: policy.approved,
        policyReason: policy.reason,
    };
}

function compareRoleSets(legacyRoles, canonicalRoles) {
    const legacy = uniqueSorted(legacyRoles);
    const canonical = uniqueSorted(canonicalRoles);
    return {
        legacy,
        canonical,
        onlyLegacy: legacy.filter((roleKey) => !canonical.includes(roleKey)),
        onlyCanonical: canonical.filter((roleKey) => !legacy.includes(roleKey)),
        equivalent: JSON.stringify(legacy) === JSON.stringify(canonical),
    };
}

async function buildCanonicalRoleRuntimeReadShadowReport(db, subjectId, options = {}) {
    const subject = normalizeJid(subjectId);
    if (!subject) {
        throw new CanonicalRoleRuntimeReadShadowError(
            'Identidade inválida para shadow de leitura do runtime.',
            'invalid_runtime_read_shadow_subject',
            { subjectId }
        );
    }

    const [legacyAdmin, legacyAccess, canonicalContext, knownSquads] = await Promise.all([
        readLegacyAdminAccessReadOnly(db, subject, { ownerCheck: options.ownerCheck }),
        readLegacyAccessContextReadOnly(db, subject, { ownerCheck: options.ownerCheck }),
        readCanonicalRoleContextReadOnly(db, subject, {
            includeLegacy: false,
            ownerCheck: options.ownerCheck,
            referenceDate: options.referenceDate,
        }),
        listKnownSquadKeysReadOnly(db),
    ]);

    const canonicalAdmin = canonicalAdminProjection(canonicalContext);
    const canonicalAccess = canonicalAccessProjection(canonicalContext);
    const permissions = uniqueSorted(options.permissions?.length
        ? options.permissions
        : permissionCatalog());
    const scopes = uniqueSorted([
        ...knownSquads,
        ...(legacyAccess.squadScopes || []),
        ...(canonicalAccess.squadScopes || []),
        ...(options.scopeKeys || []).map(normalizeSquadKey),
    ]);
    const canonicalRoles = uniqueSorted(canonicalContext.roleKeys || []);

    const adminDecisions = permissions.map((permission) => {
        const legacy = legacyAdminPermission(legacyAdmin, permission);
        const canonical = canonicalPermission(canonicalContext, permission, null);
        return {
            permission,
            legacy,
            canonical,
            ...classifySurfaceDecision({
                surface: 'admin',
                legacy,
                canonical,
                canonicalContext,
                roleKeys: canonicalRoles,
                permission,
            }),
        };
    });

    const accessGenericDecisions = permissions.map((permission) => {
        const legacy = legacyGenericPermission(legacyAccess, permission);
        const canonical = canonicalPermission(canonicalContext, permission, null);
        return {
            permission,
            legacy,
            canonical,
            ...classifySurfaceDecision({
                surface: 'access_generic',
                legacy,
                canonical,
                canonicalContext,
                roleKeys: canonicalRoles,
                permission,
            }),
        };
    });

    const accessScopedDecisions = permissions.flatMap((permission) => scopes.map((scopeKey) => {
        const legacyGeneric = legacyGenericPermission(legacyAccess, permission);
        const legacy = legacyScopedPermission(legacyAccess, permission, scopeKey);
        const canonical = canonicalPermission(canonicalContext, permission, scopeKey);
        const foreignScopeLeak = legacyGeneric === true
            && legacy === false
            && canonical === false;
        return {
            permission,
            scopeKey,
            legacyGeneric,
            legacy,
            canonical,
            foreignScopeLeak,
            ...classifySurfaceDecision({
                surface: 'access_scoped',
                legacy,
                canonical,
                canonicalContext,
                roleKeys: canonicalRoles,
                permission,
                scopeKey,
            }),
        };
    }));

    const adminRoleComparison = compareRoleSets(
        legacyAdmin?.ok && legacyAdmin.actor?.role ? [legacyAdmin.actor.role] : [],
        canonicalAdmin.roleKeys
    );
    const accessRoleComparison = compareRoleSets(
        legacyAccess.roleKeys || [],
        canonicalAccess.roleKeys
    );

    const adminCritical = adminDecisions.filter((decision) => decision.critical);
    const accessGenericCritical = accessGenericDecisions.filter((decision) => decision.critical);
    const accessScopedCritical = accessScopedDecisions.filter((decision) => decision.critical);
    const genericScopeHardening = accessGenericDecisions.filter((decision) => (
        decision.classification === 'generic_scope_hardening_required'
    ));
    const foreignScopeLeaks = accessScopedDecisions.filter((decision) => decision.foreignScopeLeak);

    const adminRoleAmbiguous = canonicalAdmin.ambiguous;
    const canonicalConflictCount = Number(canonicalContext.conflicts?.length || 0);
    const safeForAdminReader = !adminRoleAmbiguous
        && canonicalConflictCount === 0
        && adminCritical.length === 0;
    const safeForScopedAccessReader = canonicalConflictCount === 0
        && accessScopedCritical.length === 0;
    const safeForGenericAccessReader = canonicalConflictCount === 0
        && accessGenericCritical.length === 0
        && genericScopeHardening.length === 0
        && foreignScopeLeaks.length === 0;

    return {
        version: 'clover.canonical-role-runtime-read-shadow.v1',
        policyVersion: ROLE_POLICY_VERSION,
        generatedAt: new Date().toISOString(),
        subjectId: subject,
        write: false,
        queryOnlySafe: true,
        enforcementChanged: false,
        squads: scopes,
        legacy: {
            admin: legacyAdmin,
            access: legacyAccess,
        },
        canonical: {
            context: canonicalContext,
            adminProjection: canonicalAdmin,
            accessProjection: canonicalAccess,
        },
        roles: {
            admin: adminRoleComparison,
            access: accessRoleComparison,
            canonicalConflictCount,
            adminRoleAmbiguous,
        },
        decisions: {
            admin: adminDecisions,
            accessGeneric: accessGenericDecisions,
            accessScoped: accessScopedDecisions,
        },
        summary: {
            permissionCount: permissions.length,
            squadCount: scopes.length,
            adminDivergenceCount: adminDecisions.filter((decision) => decision.divergent).length,
            adminCriticalCount: adminCritical.length,
            accessGenericDivergenceCount: accessGenericDecisions.filter((decision) => decision.divergent).length,
            accessGenericCriticalCount: accessGenericCritical.length,
            accessScopedDivergenceCount: accessScopedDecisions.filter((decision) => decision.divergent).length,
            accessScopedCriticalCount: accessScopedCritical.length,
            genericScopeHardeningCount: genericScopeHardening.length,
            foreignScopeLeakCount: foreignScopeLeaks.length,
            selfCharacterReadPermissions: [...CHARACTER_READ_PERMISSIONS],
            safeForAdminReader,
            safeForScopedAccessReader,
            safeForGenericAccessReader,
            safeToSwitchAllRuntimeReaders: safeForAdminReader
                && safeForScopedAccessReader
                && safeForGenericAccessReader,
        },
    };
}

async function buildCanonicalRoleRuntimeReadShadowBatch(db, options = {}) {
    const subjects = options.subjectIds?.length
        ? uniqueSorted(options.subjectIds.map(normalizeJid))
        : await listRoleShadowSubjectsReadOnly(db);
    const reports = [];
    for (const subjectId of subjects) {
        reports.push(await buildCanonicalRoleRuntimeReadShadowReport(db, subjectId, options));
    }
    return {
        version: 'clover.canonical-role-runtime-read-shadow-batch.v1',
        policyVersion: ROLE_POLICY_VERSION,
        generatedAt: new Date().toISOString(),
        write: false,
        queryOnlySafe: true,
        enforcementChanged: false,
        subjectCount: reports.length,
        safeForAdminReaderCount: reports.filter((report) => report.summary.safeForAdminReader).length,
        safeForScopedAccessReaderCount: reports.filter((report) => report.summary.safeForScopedAccessReader).length,
        safeForGenericAccessReaderCount: reports.filter((report) => report.summary.safeForGenericAccessReader).length,
        safeToSwitchAllRuntimeReadersCount: reports.filter((report) => (
            report.summary.safeToSwitchAllRuntimeReaders
        )).length,
        adminCriticalCount: reports.reduce((sum, report) => sum + report.summary.adminCriticalCount, 0),
        accessGenericCriticalCount: reports.reduce((sum, report) => (
            sum + report.summary.accessGenericCriticalCount
        ), 0),
        accessScopedCriticalCount: reports.reduce((sum, report) => (
            sum + report.summary.accessScopedCriticalCount
        ), 0),
        genericScopeHardeningCount: reports.reduce((sum, report) => (
            sum + report.summary.genericScopeHardeningCount
        ), 0),
        foreignScopeLeakCount: reports.reduce((sum, report) => (
            sum + report.summary.foreignScopeLeakCount
        ), 0),
        reports,
    };
}

module.exports = {
    ACCESS_SURFACE_ROLES,
    ADMIN_SURFACE_ROLES,
    CanonicalRoleRuntimeReadShadowError,
    buildCanonicalRoleRuntimeReadShadowBatch,
    buildCanonicalRoleRuntimeReadShadowReport,
    canonicalAccessProjection,
    canonicalAdminProjection,
    classifySurfaceDecision,
    compareRoleSets,
    listKnownSquadKeysReadOnly,
    permissionCatalog,
    surfacePolicyDelta,
    uniqueSorted,
};