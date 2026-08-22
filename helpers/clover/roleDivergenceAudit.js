'use strict';

const { isOwner, normalizeJid } = require('../groupAccess');
const { getCanonicalRoleDefinition, normalizeScope } = require('./canonicalRoleDefinitions');
const { grantIdentity, isGrantActiveAt, rowToGrant } = require('./canonicalRoleGrantSchema');
const { readLegacyAccessGrants, readLegacyAdminGrants, tableExists } = require('./canonicalRoleGrantLegacy');

async function requireCanonicalTable(db) {
    if (!await tableExists(db, 'clover_role_grants')) {
        const error = new Error('Role divergence audit requires clover_role_grants.');
        error.code = 'role_divergence_missing_canonical_table';
        throw error;
    }
}

async function readCanonicalRoleGrantsReadOnly(db, referenceDate) {
    const rows = await db.all("SELECT * FROM clover_role_grants WHERE status = 'active' ORDER BY subject_id, role_key, scope_type, scope_key, id");
    return rows.map((row) => rowToGrant(row, 'canonical')).filter((grant) => isGrantActiveAt(grant, referenceDate));
}

function groupBySubjectAndRole(grants) {
    const grouped = new Map();
    for (const grant of grants) {
        const subjectId = normalizeJid(grant.subjectId);
        if (!subjectId) continue;
        const key = `${subjectId}|${grant.roleKey}`;
        if (!grouped.has(key)) grouped.set(key, { subject_id: subjectId, role_key: grant.roleKey, grants: [] });
        grouped.get(key).grants.push(grant);
    }
    return grouped;
}

function identities(grants) {
    return [...new Set(grants.map(grantIdentity))].sort();
}

function equalSets(left, right) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
}

async function auditRoleDivergence(db, {
    exampleLimit = 20,
    referenceDate = new Date(),
    externalSubjects = [],
    ownerCheck = isOwner,
} = {}) {
    await requireCanonicalTable(db);
    const [canonical, legacyAdmin, legacyAccess] = await Promise.all([
        readCanonicalRoleGrantsReadOnly(db, referenceDate),
        readLegacyAdminGrants(db),
        readLegacyAccessGrants(db),
    ]);
    const canonicalGroups = groupBySubjectAndRole(canonical);
    const legacyGroups = groupBySubjectAndRole([...legacyAdmin, ...legacyAccess]);
    const subjects = new Set([
        ...[...canonicalGroups.values()].map((group) => group.subject_id),
        ...[...legacyGroups.values()].map((group) => group.subject_id),
        ...externalSubjects.map(normalizeJid).filter(Boolean),
    ]);
    const keys = new Set([...canonicalGroups.keys(), ...legacyGroups.keys()]);
    const rows = [];
    for (const key of [...keys].sort()) {
        const canonicalGroup = canonicalGroups.get(key);
        const legacyGroup = legacyGroups.get(key);
        const canonicalIds = identities(canonicalGroup?.grants || []);
        const legacyIds = identities(legacyGroup?.grants || []);
        const [subjectId, roleKey] = key.split('|');
        let classification;
        if (canonicalIds.length && legacyIds.length) classification = equalSets(canonicalIds, legacyIds) ? 'AGREE' : 'CONFLICT';
        else classification = canonicalIds.length ? 'CANONICAL_ONLY' : 'LEGACY_ONLY';
        rows.push({
            principal_id: subjectId,
            role_key: roleKey,
            classification,
            canonical_grants: canonicalIds,
            legacy_grants: legacyIds,
            external_source: null,
        });
    }
    for (const subjectId of [...subjects].sort()) {
        const external = ownerCheck(subjectId);
        if (external === true) {
            rows.push({
                principal_id: subjectId,
                role_key: 'owner',
                classification: 'EXTERNAL_ONLY',
                canonical_grants: [],
                legacy_grants: [],
                external_source: 'owner_config',
            });
        } else if (external === undefined) {
            rows.push({
                principal_id: subjectId,
                role_key: 'owner',
                classification: 'UNRESOLVED_EXTERNAL',
                canonical_grants: [],
                legacy_grants: [],
                external_source: 'owner_config',
            });
        }
    }
    rows.sort((left, right) => `${left.principal_id}|${left.role_key}`.localeCompare(`${right.principal_id}|${right.role_key}`));
    const summary = {
        principals_checked: subjects.size,
        agreements: rows.filter((row) => row.classification === 'AGREE').length,
        conflicts: rows.filter((row) => row.classification === 'CONFLICT').length,
        legacy_only: rows.filter((row) => row.classification === 'LEGACY_ONLY').length,
        canonical_only: rows.filter((row) => row.classification === 'CANONICAL_ONLY').length,
        external_unresolved: rows.filter((row) => row.classification === 'UNRESOLVED_EXTERNAL').length,
    };
    summary.safe_to_cutover = summary.conflicts === 0
        && summary.legacy_only === 0
        && summary.external_unresolved === 0;
    return { ...summary, examples: rows.slice(0, Math.max(0, Math.min(100, Number(exampleLimit) || 20))) };
}

module.exports = {
    auditRoleDivergence,
    readCanonicalRoleGrantsReadOnly,
};
