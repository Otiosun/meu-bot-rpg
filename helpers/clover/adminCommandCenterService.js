'use strict';

const { diagnoseDatabaseIntegrity } = require('./databaseIntegrityService');

const PRIORITY_WEIGHT = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });
const RECOVERABLE_OPERATION_STATUSES = Object.freeze([
    'failed',
    'partially_applied',
    'retrying',
    'compensating',
]);

function boundedInteger(value, fallback = 20, maximum = 100) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(maximum, Math.trunc(parsed)));
}

function parseJson(value, fallback = null) {
    if (value === null || value === undefined || value === '') return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function timestampValue(value) {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : 0;
}

function compareItems(left, right) {
    return (PRIORITY_WEIGHT[left.priority] ?? 9) - (PRIORITY_WEIGHT[right.priority] ?? 9)
        || timestampValue(right.updatedAt) - timestampValue(left.updatedAt)
        || String(left.id).localeCompare(String(right.id));
}

async function listTables(db) {
    const rows = await db.all(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
    );
    return new Set((rows || []).map((row) => row.name));
}

async function readRecoverableOperations(db, tables, limit) {
    if (!tables.has('clover_admin_operations')) return [];
    const withUnits = tables.has('clover_admin_operation_units');
    const rows = await db.all(
        withUnits
            ? `SELECT o.id, o.code, o.status, o.title, o.reason, o.actor_id,
                      o.metadata_json, o.error_json, o.updated_at,
                      SUM(CASE WHEN u.status = 'failed' THEN 1 ELSE 0 END) AS failed_units,
                      SUM(CASE WHEN u.status = 'applied' THEN 1 ELSE 0 END) AS applied_units,
                      COUNT(u.id) AS total_units
               FROM clover_admin_operations o
               LEFT JOIN clover_admin_operation_units u ON u.operation_id = o.id
               WHERE o.status IN (${RECOVERABLE_OPERATION_STATUSES.map(() => '?').join(', ')})
               GROUP BY o.id
               ORDER BY o.updated_at DESC, o.id DESC
               LIMIT ?`
            : `SELECT id, code, status, title, reason, actor_id,
                      metadata_json, error_json, updated_at,
                      0 AS failed_units, 0 AS applied_units, 0 AS total_units
               FROM clover_admin_operations
               WHERE status IN (${RECOVERABLE_OPERATION_STATUSES.map(() => '?').join(', ')})
               ORDER BY updated_at DESC, id DESC
               LIMIT ?`,
        [...RECOVERABLE_OPERATION_STATUSES, limit]
    );
    return (rows || []).map((row) => ({
        id: `operation:${row.code}`,
        category: 'operation',
        priority: row.status === 'failed' ? 'critical' : 'high',
        title: `${row.code} · ${row.title}`,
        summary: row.status === 'failed'
            ? 'Operação falhou e exige diagnóstico ou retry protegido.'
            : row.status === 'partially_applied'
                ? 'Operação aplicada parcialmente; retry, compensação ou aceite justificado estão disponíveis.'
                : `Operação permanece em estado transitório: ${row.status}.`,
        status: row.status,
        reference: row.code,
        updatedAt: row.updated_at,
        actionPath: `/admin/operations/${row.code}`,
        metadata: {
            actorId: row.actor_id || null,
            reason: row.reason || null,
            failedUnits: Number(row.failed_units || 0),
            appliedUnits: Number(row.applied_units || 0),
            totalUnits: Number(row.total_units || 0),
            operationMetadata: parseJson(row.metadata_json, {}),
            error: parseJson(row.error_json, null),
        },
    }));
}

async function readRaidRewardProposals(db, tables, limit) {
    if (!tables.has('clover_raid_reward_proposals')) return [];
    const rows = await db.all(
        `SELECT id, raid_id, proposed_by, status, proposed_at,
                reviewed_by, reviewed_at, review_note, delivery_key
         FROM clover_raid_reward_proposals
         WHERE status IN ('pending', 'returned', 'approved')
         ORDER BY
             CASE status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
             COALESCE(reviewed_at, proposed_at) ASC,
             id ASC
         LIMIT ?`,
        [limit]
    );
    return (rows || []).map((row) => {
        const priority = row.status === 'approved'
            ? 'critical'
            : row.status === 'pending'
                ? 'high'
                : 'medium';
        const summary = row.status === 'approved'
            ? 'Proposta aprovada ainda não marcada como entregue.'
            : row.status === 'pending'
                ? 'Proposta aguarda revisão por perfil autorizado e diferente dos autores.'
                : 'Proposta devolvida aguarda correção e reenvio do responsável.';
        return {
            id: `raid-proposal:${row.id}`,
            category: 'raid_reward_proposal',
            priority,
            title: `Recompensa de Raid #${row.raid_id}`,
            summary,
            status: row.status,
            reference: String(row.id),
            updatedAt: row.reviewed_at || row.proposed_at,
            actionPath: '/admin/raids',
            metadata: {
                proposalId: Number(row.id),
                raidId: Number(row.raid_id),
                proposedBy: row.proposed_by || null,
                reviewedBy: row.reviewed_by || null,
                reviewNote: row.review_note || null,
                deliveryKey: row.delivery_key || null,
            },
        };
    });
}

async function readCanonicalTeamChanges(db, tables, limit, now) {
    if (!tables.has('clover_canonical_admin_role_changes')) return [];
    const rows = await db.all(
        `SELECT code, status, action, actor_id, target_id, requested_role,
                reason, created_at, expires_at
         FROM clover_canonical_admin_role_changes
         WHERE status = 'draft'
         ORDER BY created_at ASC, code ASC
         LIMIT ?`,
        [limit]
    );
    const nowMs = timestampValue(now);
    return (rows || []).map((row) => {
        const expired = timestampValue(row.expires_at) <= nowMs;
        return {
            id: `admin-role-change:${row.code}`,
            category: 'admin_role_change',
            priority: expired ? 'low' : 'medium',
            title: `${row.code} · ${row.action === 'revoke' ? 'Revogar cargo' : 'Alterar cargo'}`,
            summary: expired
                ? 'Prévia expirada; deve ser recriada antes de qualquer aplicação.'
                : 'Prévia de cargo aguarda aplicação ou cancelamento pelo Proprietário.',
            status: expired ? 'expired_preview' : row.status,
            reference: row.code,
            updatedAt: row.created_at,
            actionPath: '/admin/equipe',
            metadata: {
                actorId: row.actor_id,
                targetId: row.target_id,
                requestedRole: row.requested_role || null,
                reason: row.reason,
                expiresAt: row.expires_at,
            },
        };
    });
}

async function readStarAnomalies(db, tables, limit) {
    if (!tables.has('clover_squads') || !tables.has('clover_squad_star_ledger')) return [];
    const rows = await db.all(
        `SELECT s.squad_key, s.name,
                COALESCE(s.current_stars, 0) AS stored_current,
                COALESCE(s.historical_stars, 0) AS stored_historical,
                COALESCE(SUM(CASE
                    WHEN COALESCE(l.source, '') <> 'squad_reconcile' THEN l.amount
                    ELSE 0
                END), 0) AS ledger_current,
                COALESCE(SUM(CASE
                    WHEN COALESCE(l.source, '') <> 'squad_reconcile' AND l.amount > 0 THEN l.amount
                    ELSE 0
                END), 0) AS ledger_historical,
                COALESCE(SUM(CASE
                    WHEN COALESCE(l.source, '') <> 'squad_reconcile' THEN 1
                    ELSE 0
                END), 0) AS authoritative_count,
                COALESCE(SUM(CASE
                    WHEN COALESCE(l.source, '') = 'squad_reconcile' THEN 1
                    ELSE 0
                END), 0) AS synthetic_count,
                s.updated_at
         FROM clover_squads s
         LEFT JOIN clover_squad_star_ledger l ON l.squad_key = s.squad_key
         GROUP BY s.squad_key, s.name, s.current_stars, s.historical_stars, s.updated_at
         HAVING authoritative_count > 0
            AND (ledger_current < 0
                 OR stored_current <> ledger_current
                 OR stored_historical <> ledger_historical)
         ORDER BY
             CASE WHEN ledger_current < 0 THEN 0 ELSE 1 END,
             ABS(stored_current - ledger_current) DESC,
             s.squad_key ASC
         LIMIT ?`,
        [limit]
    );
    return (rows || []).map((row) => {
        const negative = Number(row.ledger_current) < 0;
        return {
            id: `stars:${row.squad_key}`,
            category: 'stars_integrity',
            priority: negative ? 'critical' : 'high',
            title: `${row.name || row.squad_key} · divergência de Estrelas`,
            summary: negative
                ? 'O ledger autoritativo produziria saldo negativo; reconciliação deve permanecer bloqueada.'
                : 'Saldo ou histórico armazenado diverge do ledger autoritativo.',
            status: negative ? 'negative_ledger_balance' : 'stored_ledger_mismatch',
            reference: row.squad_key,
            updatedAt: row.updated_at,
            actionPath: '/admin/integrity',
            metadata: {
                storedCurrent: Number(row.stored_current || 0),
                storedHistorical: Number(row.stored_historical || 0),
                ledgerCurrent: Number(row.ledger_current || 0),
                ledgerHistorical: Number(row.ledger_historical || 0),
                authoritativeCount: Number(row.authoritative_count || 0),
                ignoredSyntheticCount: Number(row.synthetic_count || 0),
            },
        };
    });
}

function integrityItems(diagnosis, limit) {
    return (diagnosis?.issues || []).slice(0, limit).map((issue, index) => ({
        id: `integrity:${issue.code}:${issue.playerId || issue.table || index}`,
        category: 'integrity',
        priority: issue.severity === 'critical' ? 'critical' : 'medium',
        title: issue.label || issue.code,
        summary: issue.message,
        status: issue.severity,
        reference: issue.playerId || issue.table || issue.code,
        updatedAt: diagnosis.generatedAt,
        actionPath: '/admin/integrity',
        metadata: {
            section: issue.section,
            code: issue.code,
            count: Number(issue.count || 1),
            data: issue.data || null,
        },
    }));
}

function summarize(items, sections) {
    const priorities = { critical: 0, high: 0, medium: 0, low: 0 };
    const categories = {};
    for (const item of items) {
        priorities[item.priority] = Number(priorities[item.priority] || 0) + 1;
        categories[item.category] = Number(categories[item.category] || 0) + 1;
    }
    return {
        total: items.length,
        priorities,
        categories,
        recoverableOperations: sections.operations.length,
        raidRewardProposals: sections.raidRewardProposals.length,
        adminRoleChanges: sections.adminRoleChanges.length,
        starAnomalies: sections.starAnomalies.length,
        integrityIssues: Number(sections.integrity?.summary?.total || sections.integrity?.issues?.length || 0),
    };
}

async function getAdminCommandCenter(db, options = {}) {
    const limit = boundedInteger(options.limit, 20, 100);
    const sampleLimit = boundedInteger(options.sampleLimit, 5, 25);
    const now = options.now || new Date().toISOString();
    const tables = await listTables(db);
    const integrityResolver = options.integrityResolver || diagnoseDatabaseIntegrity;

    const [operations, raidRewardProposals, adminRoleChanges, starAnomalies, integrity] = await Promise.all([
        readRecoverableOperations(db, tables, limit),
        readRaidRewardProposals(db, tables, limit),
        readCanonicalTeamChanges(db, tables, limit, now),
        readStarAnomalies(db, tables, limit),
        integrityResolver(db, { sampleLimit }),
    ]);

    const integrityQueue = integrityItems(integrity, sampleLimit);
    const allItems = [
        ...operations,
        ...raidRewardProposals,
        ...adminRoleChanges,
        ...starAnomalies,
        ...integrityQueue,
    ].sort(compareItems).slice(0, limit);
    const sections = {
        operations,
        raidRewardProposals,
        adminRoleChanges,
        starAnomalies,
        integrity,
    };

    return {
        ok: true,
        readOnly: true,
        generatedAt: now,
        deferredDomains: ['squad_membership_migration'],
        summary: summarize(allItems, sections),
        items: allItems,
        sections,
    };
}

async function readOperationHistory(db, tables, limit) {
    if (!tables.has('clover_admin_operation_events') || !tables.has('clover_admin_operations')) return [];
    const rows = await db.all(
        `SELECT e.id, e.event_type, e.from_status, e.to_status, e.actor_id,
                e.payload_json, e.created_at, o.code, o.title
         FROM clover_admin_operation_events e
         JOIN clover_admin_operations o ON o.id = e.operation_id
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT ?`,
        [limit]
    );
    return (rows || []).map((row) => ({
        id: `operation-event:${row.id}`,
        type: 'operation',
        action: row.event_type,
        actorId: row.actor_id || null,
        subject: row.code,
        title: `${row.code} · ${row.title}`,
        fromStatus: row.from_status || null,
        toStatus: row.to_status || null,
        occurredAt: row.created_at,
        data: parseJson(row.payload_json, null),
    }));
}

async function readTeamHistory(db, tables, limit) {
    if (!tables.has('clover_canonical_admin_role_changes')) return [];
    const rows = await db.all(
        `SELECT * FROM clover_canonical_admin_role_changes
         ORDER BY created_at DESC, code DESC
         LIMIT ?`,
        [limit]
    );
    const events = [];
    for (const row of rows || []) {
        const common = {
            type: 'admin_role',
            subject: row.code,
            title: `${row.code} · ${row.action}`,
            data: {
                targetId: row.target_id,
                requestedRole: row.requested_role || null,
                reason: row.reason,
            },
        };
        events.push({
            ...common,
            id: `admin-role:${row.code}:created`,
            action: 'created',
            actorId: row.actor_id,
            fromStatus: null,
            toStatus: 'draft',
            occurredAt: row.created_at,
        });
        for (const [action, atColumn, actorColumn, toStatus] of [
            ['applied', 'applied_at', 'applied_by', 'applied'],
            ['cancelled', 'cancelled_at', 'cancelled_by', 'cancelled'],
            ['undone', 'undone_at', 'undone_by', 'undone'],
        ]) {
            if (!row[atColumn]) continue;
            events.push({
                ...common,
                id: `admin-role:${row.code}:${action}`,
                action,
                actorId: row[actorColumn] || null,
                fromStatus: action === 'undone' ? 'applied' : 'draft',
                toStatus,
                occurredAt: row[atColumn],
            });
        }
    }
    return events;
}

async function readRaidProposalHistory(db, tables, limit) {
    if (!tables.has('clover_raid_reward_proposal_revisions')) return [];
    const rows = await db.all(
        `SELECT proposal_id, revision_number, submitted_by, submission_action,
                proposal_status, snapshot_hash, snapshot_version, submitted_at
         FROM clover_raid_reward_proposal_revisions
         ORDER BY submitted_at DESC, proposal_id DESC, revision_number DESC
         LIMIT ?`,
        [limit]
    );
    return (rows || []).map((row) => ({
        id: `raid-proposal:${row.proposal_id}:revision:${row.revision_number}`,
        type: 'raid_reward_proposal',
        action: row.submission_action,
        actorId: row.submitted_by,
        subject: String(row.proposal_id),
        title: `Proposta #${row.proposal_id} · revisão ${row.revision_number}`,
        fromStatus: null,
        toStatus: row.proposal_status,
        occurredAt: row.submitted_at,
        data: {
            revisionNumber: Number(row.revision_number),
            snapshotHash: row.snapshot_hash || null,
            snapshotVersion: Number(row.snapshot_version || 1),
        },
    }));
}

async function getAdminUnifiedHistory(db, options = {}) {
    const limit = boundedInteger(options.limit, 50, 200);
    const tables = await listTables(db);
    const [operations, team, raidProposals] = await Promise.all([
        readOperationHistory(db, tables, limit),
        readTeamHistory(db, tables, limit),
        readRaidProposalHistory(db, tables, limit),
    ]);
    let events = [...operations, ...team, ...raidProposals];
    if (options.type) events = events.filter((event) => event.type === options.type);
    const query = String(options.query || '').trim().toLowerCase();
    if (query) {
        events = events.filter((event) => (
            `${event.subject} ${event.title} ${event.actorId || ''} ${event.action}`
                .toLowerCase()
                .includes(query)
        ));
    }
    events.sort((left, right) => (
        timestampValue(right.occurredAt) - timestampValue(left.occurredAt)
        || left.id.localeCompare(right.id)
    ));
    return {
        ok: true,
        readOnly: true,
        events: events.slice(0, limit),
        sources: {
            operations: operations.length,
            adminRoles: team.length,
            raidRewardProposals: raidProposals.length,
        },
    };
}

module.exports = {
    RECOVERABLE_OPERATION_STATUSES,
    getAdminCommandCenter,
    getAdminUnifiedHistory,
};
