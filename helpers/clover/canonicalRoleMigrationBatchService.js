'use strict';

const { normalizeJid } = require('../groupAccess');
const {
    getCanonicalRoleDefinition,
    normalizeScope,
} = require('./canonicalRoleDefinitions');
const {
    detectLegacyRoleConflicts,
    readLegacyAccessGrants,
    readLegacyAdminGrants,
} = require('./canonicalRoleGrantLegacy');
const {
    ensureCanonicalRoleGrantSchema,
    grantIdentity,
    rowToGrant,
    safeJsonParse,
    serializeMetadata,
} = require('./canonicalRoleGrantSchema');

const BATCH_TABLE = 'clover_role_migration_batches';
const BATCH_GRANT_TABLE = 'clover_role_migration_batch_grants';

class CanonicalRoleMigrationError extends Error {
    constructor(message, code = 'canonical_role_migration_failed', details = null) {
        super(message || code);
        this.name = 'CanonicalRoleMigrationError';
        this.code = code;
        this.details = details;
    }
}

function uniqueSorted(values) {
    return [...new Set((values || []).filter(Boolean))].sort();
}

function normalizeReason(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeActor(value) {
    return normalizeJid(value) || String(value || '').trim();
}

async function tableExists(db, tableName) {
    return Boolean((await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tableName]
    ))?.found);
}

async function readCanonicalGrantsReadOnly(db) {
    if (!await tableExists(db, 'clover_role_grants')) return [];
    const rows = await db.all(
        `SELECT *
         FROM clover_role_grants
         WHERE status = 'active'
         ORDER BY subject_id, role_key, scope_type, scope_key, id`
    );
    return (rows || []).map((row) => rowToGrant(row, 'canonical'));
}

function validateShadowEvidence(report, currentDatabaseSha256) {
    const errors = [];
    const result = report?.result || {};
    const database = report?.database || {};
    const filters = report?.filters || {};
    const reports = Array.isArray(result.reports) ? result.reports : [];

    if (report?.version !== 'clover.canonical-role-shadow-audit.v1') {
        errors.push('unexpected_shadow_report_version');
    }
    if (report?.write !== false) errors.push('shadow_report_not_read_only');
    if (report?.queryOnlySafe !== true) errors.push('shadow_report_not_query_only_safe');
    if (database.unchanged !== true) errors.push('shadow_database_not_unchanged');
    if (!database.sha256 || database.sha256 !== currentDatabaseSha256) {
        errors.push('shadow_database_hash_mismatch');
    }
    if (report?.auditor?.expectedSha && report?.auditor?.expectedMatch !== true) {
        errors.push('shadow_auditor_sha_not_confirmed');
    }
    if ((filters.subjectIds || []).length) errors.push('shadow_subject_filter_not_allowed');
    if ((filters.scopeKeys || []).length) errors.push('shadow_scope_filter_not_allowed');
    if (!filters.referenceDate || Number.isNaN(new Date(filters.referenceDate).getTime())) {
        errors.push('shadow_reference_date_invalid');
    }
    if (!Number.isInteger(result.subjectCount) || result.subjectCount <= 0) {
        errors.push('shadow_has_no_subjects');
    }
    if (reports.length !== Number(result.subjectCount || 0)) {
        errors.push('shadow_subject_count_mismatch');
    }
    if (Number(result.criticalCount || 0) !== 0) errors.push('shadow_contains_critical_subjects');
    if (Number(result.unapprovedCanonicalExpansionCount || 0) !== 0) {
        errors.push('shadow_contains_unapproved_expansion');
    }
    if (Number(result.unapprovedCanonicalRegressionCount || 0) !== 0) {
        errors.push('shadow_contains_unapproved_regression');
    }
    if (Number(result.scopeLeakCount || 0) !== 0) errors.push('shadow_contains_scope_leak');
    if (reports.some((entry) => entry?.summary?.critical === true
        || Number(entry?.summary?.unapprovedCanonicalExpansionCount || 0) !== 0
        || Number(entry?.summary?.unapprovedCanonicalRegressionCount || 0) !== 0
        || Number(entry?.summary?.scopeLeakCount || 0) !== 0)) {
        errors.push('shadow_subject_contains_unapproved_delta');
    }

    const subjectIds = reports.map((entry) => normalizeJid(entry?.subjectId)).filter(Boolean);
    if (new Set(subjectIds).size !== subjectIds.length) errors.push('duplicate_shadow_subject');

    if (errors.length) {
        throw new CanonicalRoleMigrationError(
            'A evidência do role shadow não autoriza migração.',
            'unsafe_role_shadow_evidence',
            { errors }
        );
    }

    return {
        sourceDatabaseSha256: database.sha256,
        referenceDate: new Date(filters.referenceDate).toISOString(),
        subjectIds: uniqueSorted(subjectIds),
        subjectCount: subjectIds.length,
        approvedPolicyExpansionCount: Number(result.approvedPolicyExpansionCount || 0),
        approvedPolicyRestrictionCount: Number(result.approvedPolicyRestrictionCount || 0),
    };
}

function normalizeLegacyGrant(grant) {
    const subjectId = normalizeJid(grant?.subjectId);
    const definition = getCanonicalRoleDefinition(grant?.roleKey);
    if (!subjectId || !definition || definition.key === 'owner') return null;
    let scope;
    try {
        scope = normalizeScope(definition, grant.scopeKey);
    } catch {
        return null;
    }
    return {
        subjectId,
        roleKey: definition.key,
        scopeType: scope.scopeType,
        scopeKey: scope.scopeKey,
        legacyGrantedBy: grant.grantedBy || null,
        legacyReason: grant.reason || null,
        originType: grant.originType || grant.source || 'legacy',
        originRef: grant.originRef || null,
        metadata: grant.metadata && typeof grant.metadata === 'object' ? grant.metadata : {},
        source: grant.source || grant.originType || 'legacy',
    };
}

function provenanceFor(grant) {
    return {
        source: grant.source,
        originType: grant.originType,
        originRef: grant.originRef,
        grantedBy: grant.legacyGrantedBy,
        reason: grant.legacyReason,
        metadata: grant.metadata,
    };
}

function planSignature(plan) {
    return (plan?.planned || []).map((item) => ({
        identity: item.identity,
        origins: item.origins,
    }));
}

async function buildCanonicalRoleMigrationPlan(db, evidence) {
    const [adminLegacy, accessLegacy, canonical] = await Promise.all([
        readLegacyAdminGrants(db),
        readLegacyAccessGrants(db),
        readCanonicalGrantsReadOnly(db),
    ]);
    const legacyRaw = [...adminLegacy, ...accessLegacy];
    const conflicts = detectLegacyRoleConflicts(legacyRaw);
    if (conflicts.length) {
        throw new CanonicalRoleMigrationError(
            'As fontes legadas possuem conflito global de cargo.',
            'legacy_role_conflict',
            { conflicts }
        );
    }

    const shadowSubjects = new Set(evidence.subjectIds || []);
    const existing = new Set(canonical.map(grantIdentity));
    const grouped = new Map();
    const ignored = [];

    for (const raw of legacyRaw) {
        const grant = normalizeLegacyGrant(raw);
        if (!grant) {
            ignored.push({ reason: 'unsupported_legacy_grant', raw });
            continue;
        }
        if (!shadowSubjects.has(grant.subjectId)) {
            throw new CanonicalRoleMigrationError(
                'Um cargo legado não foi coberto pelo shadow integral.',
                'migration_subject_missing_from_shadow',
                { subjectId: grant.subjectId, roleKey: grant.roleKey }
            );
        }
        const identity = grantIdentity(grant);
        if (existing.has(identity)) continue;
        if (!grouped.has(identity)) {
            grouped.set(identity, {
                identity,
                subjectId: grant.subjectId,
                roleKey: grant.roleKey,
                scopeType: grant.scopeType,
                scopeKey: grant.scopeKey,
                origins: [],
            });
        }
        grouped.get(identity).origins.push(provenanceFor(grant));
    }

    const planned = [...grouped.values()]
        .map((item) => ({
            ...item,
            origins: item.origins.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
            originType: item.origins.length > 1 ? 'legacy_role_union' : item.origins[0]?.originType || 'legacy',
            originRef: item.origins.length === 1 ? item.origins[0]?.originRef || null : item.identity,
        }))
        .sort((left, right) => left.identity.localeCompare(right.identity));

    return {
        write: false,
        safe: true,
        sourceDatabaseSha256: evidence.sourceDatabaseSha256,
        referenceDate: evidence.referenceDate,
        shadowSubjectCount: evidence.subjectCount,
        legacyAdminCount: adminLegacy.length,
        legacyAccessCount: accessLegacy.length,
        legacyCount: legacyRaw.length,
        canonicalActiveCount: canonical.length,
        plannedCount: planned.length,
        planned,
        ignored,
        conflicts: [],
        signature: planSignature({ planned }),
    };
}

async function ensureCanonicalRoleMigrationSchema(db) {
    await ensureCanonicalRoleGrantSchema(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS ${BATCH_TABLE} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_database_sha256 TEXT NOT NULL,
            shadow_report_sha256 TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'applied'
                CHECK (status IN ('applied', 'rolled_back')),
            planned_count INTEGER NOT NULL,
            inserted_count INTEGER NOT NULL,
            applied_by TEXT NOT NULL,
            apply_reason TEXT NOT NULL,
            applied_at TEXT DEFAULT CURRENT_TIMESTAMP,
            rolled_back_at TEXT DEFAULT NULL,
            rolled_back_by TEXT DEFAULT NULL,
            rollback_reason TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        )
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS ${BATCH_GRANT_TABLE} (
            batch_id INTEGER NOT NULL,
            grant_id INTEGER NOT NULL,
            subject_id TEXT NOT NULL,
            role_key TEXT NOT NULL,
            scope_type TEXT NOT NULL,
            scope_key TEXT NOT NULL,
            origin_type TEXT NOT NULL,
            origin_ref TEXT DEFAULT NULL,
            PRIMARY KEY (batch_id, grant_id),
            FOREIGN KEY (batch_id) REFERENCES ${BATCH_TABLE}(id),
            FOREIGN KEY (grant_id) REFERENCES clover_role_grants(id)
        )
    `);
    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_role_migration_batch_grant
        ON ${BATCH_GRANT_TABLE} (grant_id)
    `);
}

async function writeGrantEvent(db, grant, action, actor, reason, payload = {}) {
    await db.run(
        `INSERT INTO clover_role_grant_events
         (grant_id, subject_id, role_key, scope_type, scope_key, action,
          performed_by, reason, origin_type, origin_ref, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            grant.id,
            grant.subject_id,
            grant.role_key,
            grant.scope_type,
            grant.scope_key,
            action,
            actor,
            reason,
            grant.origin_type || null,
            grant.origin_ref || null,
            serializeMetadata(payload),
        ]
    );
}

async function applyCanonicalRoleMigrationPlan(db, plan, options = {}) {
    const actor = normalizeActor(options.actor);
    const reason = normalizeReason(options.reason);
    const shadowReportSha256 = String(options.shadowReportSha256 || '').trim();
    if (!actor) throw new CanonicalRoleMigrationError('Informe o responsável.', 'migration_actor_required');
    if (reason.length < 8) throw new CanonicalRoleMigrationError('Informe um motivo detalhado.', 'migration_reason_required');
    if (!/^[a-f0-9]{64}$/i.test(shadowReportSha256)) {
        throw new CanonicalRoleMigrationError('Hash do relatório shadow inválido.', 'shadow_report_sha256_required');
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        const freshPlan = await buildCanonicalRoleMigrationPlan(db, {
            sourceDatabaseSha256: plan.sourceDatabaseSha256,
            referenceDate: plan.referenceDate,
            subjectIds: options.shadowSubjectIds,
            subjectCount: options.shadowSubjectIds?.length || 0,
        });
        if (JSON.stringify(freshPlan.signature) !== JSON.stringify(plan.signature)) {
            throw new CanonicalRoleMigrationError(
                'O plano de migração mudou antes da escrita.',
                'role_migration_plan_drift',
                { expected: plan.signature, actual: freshPlan.signature }
            );
        }

        await ensureCanonicalRoleMigrationSchema(db);
        const batchInsert = await db.run(
            `INSERT INTO ${BATCH_TABLE}
             (source_database_sha256, shadow_report_sha256, status,
              planned_count, inserted_count, applied_by, apply_reason, metadata_json)
             VALUES (?, ?, 'applied', ?, 0, ?, ?, ?)`,
            [
                plan.sourceDatabaseSha256,
                shadowReportSha256,
                plan.plannedCount,
                actor,
                reason,
                serializeMetadata({
                    referenceDate: plan.referenceDate,
                    legacyAdminCount: plan.legacyAdminCount,
                    legacyAccessCount: plan.legacyAccessCount,
                    shadowSubjectCount: plan.shadowSubjectCount,
                }),
            ]
        );
        const batchId = Number(batchInsert.lastID);
        const inserted = [];

        for (const item of plan.planned) {
            const metadata = {
                migrationBatchId: batchId,
                sourceDatabaseSha256: plan.sourceDatabaseSha256,
                shadowReportSha256,
                legacyOrigins: item.origins,
            };
            const grantInsert = await db.run(
                `INSERT INTO clover_role_grants
                 (subject_id, role_key, scope_type, scope_key, status,
                  granted_by, grant_reason, origin_type, origin_ref, metadata_json)
                 VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
                [
                    item.subjectId,
                    item.roleKey,
                    item.scopeType,
                    item.scopeKey,
                    actor,
                    reason,
                    item.originType,
                    item.originRef,
                    serializeMetadata(metadata),
                ]
            );
            const grant = await db.get('SELECT * FROM clover_role_grants WHERE id = ?', [grantInsert.lastID]);
            await db.run(
                `INSERT INTO ${BATCH_GRANT_TABLE}
                 (batch_id, grant_id, subject_id, role_key, scope_type, scope_key, origin_type, origin_ref)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    batchId,
                    grant.id,
                    grant.subject_id,
                    grant.role_key,
                    grant.scope_type,
                    grant.scope_key,
                    grant.origin_type,
                    grant.origin_ref,
                ]
            );
            await writeGrantEvent(db, grant, 'granted', actor, reason, {
                migrationBatchId: batchId,
                sourceDatabaseSha256: plan.sourceDatabaseSha256,
                shadowReportSha256,
            });
            inserted.push({
                grantId: Number(grant.id),
                identity: grantIdentity(rowToGrant(grant)),
            });
        }

        if (inserted.length !== plan.plannedCount) {
            throw new CanonicalRoleMigrationError(
                'A quantidade inserida diverge do plano.',
                'role_migration_insert_count_mismatch',
                { planned: plan.plannedCount, inserted: inserted.length }
            );
        }
        await db.run(
            `UPDATE ${BATCH_TABLE}
             SET inserted_count = ?
             WHERE id = ? AND status = 'applied'`,
            [inserted.length, batchId]
        );
        await db.exec('COMMIT');
        return {
            write: true,
            batchId,
            plannedCount: plan.plannedCount,
            insertedCount: inserted.length,
            inserted,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function buildCanonicalRoleRollbackPlan(db, batchId) {
    if (!await tableExists(db, BATCH_TABLE) || !await tableExists(db, BATCH_GRANT_TABLE)) {
        throw new CanonicalRoleMigrationError('Tabelas do lote ausentes.', 'migration_batch_schema_missing');
    }
    const batch = await db.get(`SELECT * FROM ${BATCH_TABLE} WHERE id = ?`, [batchId]);
    if (!batch) throw new CanonicalRoleMigrationError('Lote não encontrado.', 'migration_batch_not_found');
    if (batch.status !== 'applied') {
        throw new CanonicalRoleMigrationError('O lote não está aplicado.', 'migration_batch_not_applied', { status: batch.status });
    }
    const rows = await db.all(
        `SELECT bg.*, g.status, g.origin_type AS grant_origin_type,
                g.origin_ref AS grant_origin_ref, g.metadata_json
         FROM ${BATCH_GRANT_TABLE} bg
         JOIN clover_role_grants g ON g.id = bg.grant_id
         WHERE bg.batch_id = ?
         ORDER BY bg.grant_id`,
        [batchId]
    );
    if (rows.length !== Number(batch.inserted_count || 0)) {
        throw new CanonicalRoleMigrationError(
            'O lote perdeu grants vinculados.',
            'migration_batch_grant_count_mismatch',
            { expected: Number(batch.inserted_count || 0), actual: rows.length }
        );
    }
    const unsafe = rows.filter((row) => {
        const metadata = safeJsonParse(row.metadata_json, {});
        return row.status !== 'active'
            || row.grant_origin_type !== row.origin_type
            || (row.grant_origin_ref || null) !== (row.origin_ref || null)
            || Number(metadata.migrationBatchId || 0) !== Number(batchId);
    });
    if (unsafe.length) {
        throw new CanonicalRoleMigrationError(
            'Um grant do lote foi alterado depois da migração.',
            'migration_batch_grant_drift',
            { grantIds: unsafe.map((row) => Number(row.grant_id)) }
        );
    }
    return {
        write: false,
        safe: true,
        batchId: Number(batch.id),
        grantCount: rows.length,
        grantIds: rows.map((row) => Number(row.grant_id)),
        batch,
        rows,
    };
}

async function rollbackCanonicalRoleMigrationBatch(db, rollbackPlan, options = {}) {
    const actor = normalizeActor(options.actor);
    const reason = normalizeReason(options.reason);
    if (!actor) throw new CanonicalRoleMigrationError('Informe o responsável.', 'rollback_actor_required');
    if (reason.length < 8) throw new CanonicalRoleMigrationError('Informe um motivo detalhado.', 'rollback_reason_required');

    await db.exec('BEGIN IMMEDIATE');
    try {
        const fresh = await buildCanonicalRoleRollbackPlan(db, rollbackPlan.batchId);
        if (JSON.stringify(fresh.grantIds) !== JSON.stringify(rollbackPlan.grantIds)) {
            throw new CanonicalRoleMigrationError('O lote mudou antes do rollback.', 'migration_rollback_plan_drift');
        }
        for (const row of fresh.rows) {
            const updated = await db.run(
                `UPDATE clover_role_grants
                 SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP,
                     revoked_by = ?, revoke_reason = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = 'active'`,
                [actor, reason, row.grant_id]
            );
            if (Number(updated.changes || 0) !== 1) {
                throw new CanonicalRoleMigrationError(
                    'Falha ao revogar exatamente um grant.',
                    'migration_grant_revoke_count_mismatch',
                    { grantId: Number(row.grant_id), changes: Number(updated.changes || 0) }
                );
            }
            const grant = await db.get('SELECT * FROM clover_role_grants WHERE id = ?', [row.grant_id]);
            await writeGrantEvent(db, grant, 'revoked', actor, reason, {
                migrationBatchId: rollbackPlan.batchId,
                rollback: true,
            });
        }
        const batchUpdate = await db.run(
            `UPDATE ${BATCH_TABLE}
             SET status = 'rolled_back', rolled_back_at = CURRENT_TIMESTAMP,
                 rolled_back_by = ?, rollback_reason = ?
             WHERE id = ? AND status = 'applied'`,
            [actor, reason, rollbackPlan.batchId]
        );
        if (Number(batchUpdate.changes || 0) !== 1) {
            throw new CanonicalRoleMigrationError('Falha ao marcar rollback do lote.', 'migration_batch_rollback_count_mismatch');
        }
        await db.exec('COMMIT');
        return {
            write: true,
            batchId: rollbackPlan.batchId,
            revokedCount: rollbackPlan.grantCount,
            grantIds: rollbackPlan.grantIds,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    BATCH_GRANT_TABLE,
    BATCH_TABLE,
    CanonicalRoleMigrationError,
    applyCanonicalRoleMigrationPlan,
    buildCanonicalRoleMigrationPlan,
    buildCanonicalRoleRollbackPlan,
    ensureCanonicalRoleMigrationSchema,
    planSignature,
    readCanonicalGrantsReadOnly,
    rollbackCanonicalRoleMigrationBatch,
    tableExists,
    validateShadowEvidence,
};
