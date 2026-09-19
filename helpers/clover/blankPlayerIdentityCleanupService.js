'use strict';

const ARCHIVE_TABLE = 'clover_blank_player_identity_archive';
const INSERT_TRIGGER = 'trg_jogadores_require_nonblank_id_insert';
const UPDATE_TRIGGER = 'trg_jogadores_require_nonblank_id_update';
const ALLOWED_REVIEW_REASONS = new Set(['players_id_allows_null']);

class BlankPlayerIdentityCleanupError extends Error {
    constructor(message, code = 'blank_player_identity_cleanup_failed', details = null) {
        super(message || code);
        this.name = 'BlankPlayerIdentityCleanupError';
        this.code = code;
        this.details = details;
    }
}

function normalizeToken(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function isBlank(value) {
    return value === null || value === undefined || String(value).trim() === '';
}

function isEmptyPlaceholder(value) {
    if (value === null || value === undefined) return true;
    if (typeof value !== 'string') return false;
    const text = value.trim();
    return text === '' || text === '-' || text === '[]' || text === '{}';
}

function isExactCacadorPlaceholder(row = {}) {
    return isBlank(row.id)
        && normalizeToken(row.nome) === 'cacador'
        && normalizeToken(row.display_name) === 'cacador'
        && isEmptyPlaceholder(row.personagem_nome)
        && isBlank(row.canonical_player_id)
        && normalizeToken(row.ficha_status) === 'incompleta'
        && normalizeToken(row.jogo_status) === 'bloqueado'
        && isEmptyPlaceholder(row.esquadrao)
        && Number(row.is_shadow || 0) === 0
        && isBlank(row.merged_into)
        && isBlank(row.archived_at)
        && isBlank(row.archive_reason);
}

function validateAuditEvidence(report, currentDatabaseSha256) {
    const errors = [];
    const database = report?.database || {};
    const result = report?.result || {};
    const summary = result.summary || {};
    const reviewReasons = Array.isArray(result.reviewReasons) ? result.reviewReasons : [];
    const rows = Array.isArray(result.rows) ? result.rows : [];

    if (report?.write !== false) errors.push('audit_report_not_read_only');
    if (report?.queryOnlySafe !== true) errors.push('audit_report_not_query_only_safe');
    if (database.unchanged !== true) errors.push('audit_database_not_unchanged');
    if (!database.sha256 || database.sha256 !== currentDatabaseSha256) {
        errors.push('audit_database_hash_mismatch');
    }
    if (summary.critical === true) errors.push('audit_contains_critical_findings');
    if (!Number.isInteger(summary.blankIdentityCount) || summary.blankIdentityCount <= 0) {
        errors.push('audit_has_no_blank_identities');
    }
    if (summary.exactPlaceholderCount !== summary.blankIdentityCount) {
        errors.push('not_all_blank_identities_are_exact_placeholders');
    }
    if (Number(summary.dataBearingCount || 0) !== 0) errors.push('data_bearing_blank_identity_found');
    if (Number(summary.signatureMismatchCount || 0) !== 0) errors.push('blank_identity_signature_mismatch');
    if (Number(summary.foreignKeyDefinitionCount || 0) !== 0) errors.push('foreign_key_to_players_found');
    if (Number(summary.explicitRowidReferenceCount || 0) !== 0) errors.push('rowid_reference_found');
    if (Number(summary.externalNameReferenceCount || 0) !== 0) errors.push('external_name_reference_found');
    if (rows.length !== Number(summary.blankIdentityCount || 0)) errors.push('audit_row_count_mismatch');
    if (rows.some((row) => row.placeholderSignature !== true
        || Number(row.substantiveDeviationCount || 0) !== 0
        || !Number.isInteger(row.rowid))) {
        errors.push('audit_row_not_safe_placeholder');
    }
    if (new Set(rows.map((row) => row.rowid)).size !== rows.length) {
        errors.push('duplicate_audit_rowid');
    }
    const unsupportedReviewReasons = reviewReasons.filter((reason) => !ALLOWED_REVIEW_REASONS.has(reason));
    if (unsupportedReviewReasons.length) errors.push('unsupported_review_reason');
    if (!reviewReasons.includes('players_id_allows_null')) {
        errors.push('nullable_id_review_reason_missing');
    }

    if (errors.length) {
        throw new BlankPlayerIdentityCleanupError(
            'A evidência não autoriza limpeza automática.',
            'unsafe_blank_identity_evidence',
            { errors, unsupportedReviewReasons }
        );
    }

    return {
        sourceDatabaseSha256: database.sha256,
        expectedRowids: rows.map((row) => row.rowid).sort((a, b) => a - b),
        expectedCount: rows.length,
        allowedReviewReasons: reviewReasons,
    };
}

async function readRowsByRowid(db, rowids) {
    if (!rowids.length) return [];
    const placeholders = rowids.map(() => '?').join(', ');
    return db.all(
        `SELECT rowid AS __rowid__, *
         FROM jogadores
         WHERE rowid IN (${placeholders})
         ORDER BY rowid`,
        rowids
    );
}

async function buildCleanupPlan(db, evidence) {
    const rows = await readRowsByRowid(db, evidence.expectedRowids);
    const foundRowids = rows.map((row) => Number(row.__rowid__)).sort((a, b) => a - b);
    if (JSON.stringify(foundRowids) !== JSON.stringify(evidence.expectedRowids)) {
        throw new BlankPlayerIdentityCleanupError(
            'Os rowids atuais não correspondem à evidência.',
            'blank_identity_rowid_drift',
            { expected: evidence.expectedRowids, found: foundRowids }
        );
    }
    const unsafe = rows.filter((row) => !isExactCacadorPlaceholder(row));
    if (unsafe.length) {
        throw new BlankPlayerIdentityCleanupError(
            'Um placeholder mudou ou contém dados relevantes.',
            'blank_identity_signature_changed',
            { rowids: unsafe.map((row) => row.__rowid__) }
        );
    }
    const totalBlank = await db.get(
        `SELECT COUNT(*) AS total
         FROM jogadores
         WHERE id IS NULL OR TRIM(CAST(id AS TEXT)) = ''`
    );
    if (Number(totalBlank?.total || 0) !== rows.length) {
        throw new BlankPlayerIdentityCleanupError(
            'Existem identidades vazias fora da evidência aprovada.',
            'unreviewed_blank_identity_found',
            { audited: rows.length, current: Number(totalBlank?.total || 0) }
        );
    }
    return {
        write: false,
        safe: true,
        sourceDatabaseSha256: evidence.sourceDatabaseSha256,
        rowCount: rows.length,
        rowids: foundRowids,
        rows,
    };
}

async function ensureContainmentSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS ${ARCHIVE_TABLE} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_database_sha256 TEXT NOT NULL,
            source_rowid INTEGER NOT NULL,
            row_json TEXT NOT NULL,
            archived_by TEXT NOT NULL,
            reason TEXT NOT NULL,
            archived_at TEXT DEFAULT CURRENT_TIMESTAMP,
            restored_at TEXT DEFAULT NULL,
            restored_by TEXT DEFAULT NULL,
            restore_reason TEXT DEFAULT NULL,
            UNIQUE (source_database_sha256, source_rowid)
        )
    `);
    await db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${INSERT_TRIGGER}
        BEFORE INSERT ON jogadores
        WHEN NEW.id IS NULL OR TRIM(CAST(NEW.id AS TEXT)) = ''
        BEGIN
            SELECT RAISE(ABORT, 'player_id_required');
        END
    `);
    await db.exec(`
        CREATE TRIGGER IF NOT EXISTS ${UPDATE_TRIGGER}
        BEFORE UPDATE OF id ON jogadores
        WHEN NEW.id IS NULL OR TRIM(CAST(NEW.id AS TEXT)) = ''
        BEGIN
            SELECT RAISE(ABORT, 'player_id_required');
        END
    `);
}

async function applyCleanupPlan(db, plan, options = {}) {
    const actor = String(options.actor || '').trim();
    const reason = String(options.reason || '').trim().replace(/\s+/g, ' ');
    if (!actor) {
        throw new BlankPlayerIdentityCleanupError('Informe o responsável.', 'cleanup_actor_required');
    }
    if (reason.length < 8) {
        throw new BlankPlayerIdentityCleanupError('Informe um motivo detalhado.', 'cleanup_reason_required');
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        const freshPlan = await buildCleanupPlan(db, {
            sourceDatabaseSha256: plan.sourceDatabaseSha256,
            expectedRowids: plan.rowids,
        });
        await ensureContainmentSchema(db);
        const archived = [];
        for (const row of freshPlan.rows) {
            const rowid = Number(row.__rowid__);
            const rowJson = { ...row };
            delete rowJson.__rowid__;
            const result = await db.run(
                `INSERT INTO ${ARCHIVE_TABLE}
                 (source_database_sha256, source_rowid, row_json, archived_by, reason)
                 VALUES (?, ?, ?, ?, ?)`,
                [
                    plan.sourceDatabaseSha256,
                    rowid,
                    JSON.stringify(rowJson),
                    actor,
                    reason,
                ]
            );
            const deletion = await db.run(
                `DELETE FROM jogadores
                 WHERE rowid = ?
                   AND (id IS NULL OR TRIM(CAST(id AS TEXT)) = '')`,
                [rowid]
            );
            if (Number(deletion?.changes || 0) !== 1) {
                throw new BlankPlayerIdentityCleanupError(
                    'Falha ao remover exatamente um placeholder.',
                    'placeholder_delete_count_mismatch',
                    { rowid, changes: Number(deletion?.changes || 0) }
                );
            }
            archived.push({ archiveId: result.lastID, sourceRowid: rowid });
        }
        const remaining = await db.get(
            `SELECT COUNT(*) AS total
             FROM jogadores
             WHERE id IS NULL OR TRIM(CAST(id AS TEXT)) = ''`
        );
        if (Number(remaining?.total || 0) !== 0) {
            throw new BlankPlayerIdentityCleanupError(
                'Ainda existem identidades vazias após a limpeza.',
                'blank_identity_remaining',
                { remaining: Number(remaining?.total || 0) }
            );
        }
        await db.exec('COMMIT');
        return {
            write: true,
            archivedCount: archived.length,
            deletedCount: archived.length,
            containmentInstalled: true,
            archiveTable: ARCHIVE_TABLE,
            triggers: [INSERT_TRIGGER, UPDATE_TRIGGER],
            archived,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    ALLOWED_REVIEW_REASONS,
    ARCHIVE_TABLE,
    BlankPlayerIdentityCleanupError,
    INSERT_TRIGGER,
    UPDATE_TRIGGER,
    applyCleanupPlan,
    buildCleanupPlan,
    ensureContainmentSchema,
    isExactCacadorPlaceholder,
    validateAuditEvidence,
};
