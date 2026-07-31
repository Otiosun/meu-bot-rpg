'use strict';

const { normalizeJid } = require('../groupAccess');
const { normalizeSquadKey } = require('./cavalierService');
const { CANONICAL_ROLE_DEFINITIONS } = require('./canonicalRoleDefinitions');
const {
    legacyRoleGrantsPermission,
    listRoleShadowSubjectsReadOnly,
    readCanonicalRoleContextReadOnly,
    readLegacyAccessContextReadOnly,
    readLegacyAdminAccessReadOnly,
} = require('./canonicalRoleShadowReadOnly');

function uniqueSorted(values) {
    return [...new Set((values || []).filter(Boolean))].sort();
}

function canonicalPermissionCatalog() {
    return uniqueSorted(Object.values(CANONICAL_ROLE_DEFINITIONS)
        .flatMap((definition) => definition.permissions || [])
        .filter((permission) => permission !== '*'));
}

function legacyAdminPermission(access, permission) {
    if (!access?.ok) return false;
    const capabilities = access.actor?.capabilities || [];
    return capabilities.includes('*') || capabilities.includes(permission);
}

function legacyGenericPermission(context, permission) {
    if (!context) return false;
    if (context.owner) return true;
    return context.permissions?.includes('*') || context.permissions?.includes(permission) || false;
}

function legacyScopedPermission(context, permission, scopeKey = null) {
    if (!context) return false;
    if (context.owner) return true;
    const normalizedScope = normalizeSquadKey(scopeKey);
    for (const assignment of context.assignments || []) {
        if (!legacyRoleGrantsPermission(assignment.role_key, permission)) continue;
        if (assignment.scope_type === 'global') return true;
        if (assignment.scope_type === 'squad'
            && normalizedScope
            && assignment.scope_key === normalizedScope) return true;
    }
    return false;
}

function canonicalPermission(context, permission, scopeKey = null) {
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

function classifyDecision({ admin, generic, scoped, canonical, scopeKey }) {
    const classifications = [];
    if (admin !== canonical) classifications.push('admin_vs_canonical');
    if (scoped !== canonical) classifications.push('access_scoped_vs_canonical');
    if (generic !== scoped) classifications.push(scopeKey ? 'legacy_scope_leak' : 'legacy_scope_ambiguity');
    return classifications;
}

function normalizeProbe(probe) {
    if (typeof probe === 'string') return { permission: probe, scopeKey: null };
    return {
        permission: String(probe?.permission || '').trim(),
        scopeKey: normalizeSquadKey(probe?.scopeKey) || null,
    };
}

async function buildCanonicalRoleShadowReport(db, subjectId, options = {}) {
    const subject = normalizeJid(subjectId);
    if (!subject) {
        const error = new Error('Identidade inválida para comparação de cargos.');
        error.code = 'invalid_shadow_subject';
        throw error;
    }

    const [adminAccess, accessContext, canonicalContext] = await Promise.all([
        readLegacyAdminAccessReadOnly(db, subject, options.adminOptions || {}),
        readLegacyAccessContextReadOnly(db, subject, { ownerCheck: options.ownerCheck }),
        readCanonicalRoleContextReadOnly(db, subject, {
            includeLegacy: options.includeLegacy !== false,
            ownerCheck: options.ownerCheck,
            referenceDate: options.referenceDate,
        }),
    ]);

    const scopes = uniqueSorted([
        ...(accessContext.squadScopes || []),
        ...Object.values(canonicalContext.permissionScopes || {})
            .flatMap((scope) => scope?.squads || []),
        ...(options.scopeKeys || []).map(normalizeSquadKey),
    ]);
    const requestedProbes = Array.isArray(options.probes) && options.probes.length
        ? options.probes.map(normalizeProbe).filter((probe) => probe.permission)
        : canonicalPermissionCatalog().flatMap((permission) => [
            { permission, scopeKey: null },
            ...scopes.map((scopeKey) => ({ permission, scopeKey })),
        ]);

    const decisions = requestedProbes.map(({ permission, scopeKey }) => {
        const admin = legacyAdminPermission(adminAccess, permission);
        const generic = legacyGenericPermission(accessContext, permission);
        const scoped = legacyScopedPermission(accessContext, permission, scopeKey);
        const canonical = canonicalPermission(canonicalContext, permission, scopeKey);
        const classifications = classifyDecision({ admin, generic, scoped, canonical, scopeKey });
        return {
            permission,
            scopeKey,
            legacyAdmin: admin,
            legacyAccessGeneric: generic,
            legacyAccessScoped: scoped,
            canonical,
            classifications,
            divergent: classifications.length > 0,
        };
    });

    const legacyAdminRoles = adminAccess?.ok ? [adminAccess.actor.role] : [];
    const legacyAccessRoles = uniqueSorted(accessContext.roleKeys || []);
    const canonicalRoles = uniqueSorted(canonicalContext.roleKeys || []);
    const observedCanonicalRoles = uniqueSorted(canonicalContext.observedRoleKeys || []);
    const roleUnion = uniqueSorted([...legacyAdminRoles, ...legacyAccessRoles, ...observedCanonicalRoles]);
    const roleDivergence = roleUnion.filter((role) => (
        legacyAdminRoles.includes(role) !== canonicalRoles.includes(role)
        || legacyAccessRoles.includes(role) !== canonicalRoles.includes(role)
    ));
    const divergentDecisions = decisions.filter((decision) => decision.divergent);
    const scopeLeaks = decisions.filter((decision) => decision.classifications.includes('legacy_scope_leak'));

    return {
        subjectId: subject,
        write: false,
        queryOnlySafe: true,
        legacy: {
            admin: {
                ok: Boolean(adminAccess?.ok),
                role: adminAccess?.actor?.role || null,
                capabilities: uniqueSorted(adminAccess?.actor?.capabilities || []),
                source: adminAccess?.actor?.source || null,
            },
            access: {
                owner: Boolean(accessContext.owner),
                roleKeys: legacyAccessRoles,
                permissions: uniqueSorted(accessContext.permissions || []),
                squadScopes: uniqueSorted(accessContext.squadScopes || []),
            },
        },
        canonical: {
            owner: Boolean(canonicalContext.owner),
            roleKeys: canonicalRoles,
            observedRoleKeys: observedCanonicalRoles,
            permissionScopes: canonicalContext.permissionScopes || {},
            conflicts: canonicalContext.conflicts || [],
            blockedByConflict: Boolean(canonicalContext.blockedByConflict),
            sources: uniqueSorted(canonicalContext.sources || []),
        },
        roles: {
            divergent: roleDivergence.length > 0 || Boolean(canonicalContext.conflicts?.length),
            differingRoleKeys: roleDivergence,
        },
        decisions,
        summary: {
            probeCount: decisions.length,
            divergentDecisionCount: divergentDecisions.length,
            scopeLeakCount: scopeLeaks.length,
            canonicalConflictCount: Number(canonicalContext.conflicts?.length || 0),
            critical: Boolean(
                canonicalContext.blockedByConflict
                || scopeLeaks.length
                || divergentDecisions.some((decision) => decision.canonical && !decision.legacyAccessScoped)
            ),
        },
    };
}

async function listRoleShadowSubjects(db) {
    return listRoleShadowSubjectsReadOnly(db);
}

async function buildCanonicalRoleShadowBatch(db, options = {}) {
    const subjects = options.subjectIds?.length
        ? uniqueSorted(options.subjectIds.map(normalizeJid))
        : await listRoleShadowSubjects(db);
    const reports = [];
    for (const subjectId of subjects) {
        reports.push(await buildCanonicalRoleShadowReport(db, subjectId, options));
    }
    return {
        write: false,
        queryOnlySafe: true,
        generatedAt: new Date().toISOString(),
        subjectCount: reports.length,
        criticalCount: reports.filter((report) => report.summary.critical).length,
        divergentCount: reports.filter((report) => (
            report.roles.divergent || report.summary.divergentDecisionCount > 0
        )).length,
        reports,
    };
}

module.exports = {
    buildCanonicalRoleShadowBatch,
    buildCanonicalRoleShadowReport,
    canonicalPermission,
    canonicalPermissionCatalog,
    classifyDecision,
    legacyAdminPermission,
    legacyGenericPermission,
    legacyScopedPermission,
    listRoleShadowSubjects,
};
