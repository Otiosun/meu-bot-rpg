'use strict';

const {
    ARCHIVE_TABLE,
    BlankPlayerIdentityCleanupError,
    INSERT_TRIGGER,
    UPDATE_TRIGGER,
    ensureContainmentSchema,
    isExactCacadorPlaceholder,
} = require('./blankPlayerIdentityCleanupService');

class BlankPlayerIdentityRestoreError extends BlankPlayerIdentityCleanupError {
    constructor(message, code = 'blank_player_identity_restore_failed', details = null) {
        super(message || code, code, details);
        this.name = 'BlankPlayerIdentityRestoreError';
    }
}

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function uniqueSortedNumbers(values) {
    return [...new Set((values || []).map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
}

function validateCleanupReceipt(receipt, currentDatabaseSha256) {
    const errors = [];
    const database = receipt?.database || {};
    const applied = receipt?.applied || {};
    const plan = receipt?.plan || {};
    const archived = Array.isArray(applied.archived) ? applied.archived : [];

    if (receipt?.write !== true) errors.push('cleanup_receipt_not_write');
    if (receipt?.mode !== 'apply') errors.push('cleanup_receipt_not_apply');
    if (!database.sha256After || database.sha256After !== currentDatabaseSha256) {
        errors.push('cleanup_receipt_database_hash_mismatch');
    }
    if (!database.sha256Before) errors.push('cleanup_receipt_source_hash_missing');
    if (applied.containmentInstalled !== true) errors.push('cleanup_containment_not_confirmed');
    if (!Number.isInteger(applied.archivedCount) || applied.archivedCount <= 0) {
        errors.push('cleanup_archived_count_invalid');
    }
    if (applied.archivedCount !== applied.deletedCount) errors.push('cleanup_count_mismatch');
    if (archived.length !== Number(applied.archivedCount || 0)) errors.push('cleanup_archive_list_mismatch');
    if (Number(plan.rowCount || 0) !== Number(applied.archivedCount || 0)) {
        errors.push('cleanup_plan_count_mismatch');
    }

    const archiveIds = archived.map((item) => Number(item?.archiveId));
    const rowids = archived.map((item) => Number(item?.sourceRowid));
    if (archiveIds.some((value) => !Number.isInteger(value) || value <= 0)) {
        errors.push('cleanup_archive_id_invalid');
    }
    if (rowids.some((value) => !Number.isInteger(value) || value <= 0)) {
        errors.push('cleanup_source_rowid_invalid');
    }
    if (new Set(archiveIds).size !== archiveIds.length) errors.push('cleanup_duplicate_archive_id');
    if (new Set(rowids).size !== rowids.length) errors.push('cleanup_duplicate_source_rowid');

    const plannedRowids = uniqueSortedNumbers(plan.rowids || []);
    const archivedRowids = uniqueSortedNumbers(rowids);
    if (JSON.stringify(plannedRowids) !== JSON.stringify(archivedRowids)) {
        errors.push('cleanup_plan_rowids_mismatch');
    }

    if (errors.length) {
        throw new BlankPlayerIdentityRestoreError(
            'O recibo da limpeza não autoriza restauração.',
            'unsafe_cleanup_receipt',
            { errors }
        );
    }

    return {
        cleanedDatabaseSha256: database.sha256After,
        sourceDatabaseSha256: database.sha256Before,
        archiveIds: archiveIds.sort((a, b) => a - b),
        sourceRowids: archivedRowids,
        expectedCount: archived.length,
    };
}

async function tableExists(db, tableName) {
    return Boolean((await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tableName]
    ))?.found);
}

async function listPlayerColumns(db) {
    const columns = await db.all('PRAGMA table_info(jogadores)');
    return (columns || []).map((column) => column.name).filter(Boolean);
}

async function readArchiveRows(db, archiveIds) {
    if (!archiveIds.length) return [];
    const placeholders = archiveIds.map(() => '?').join(', ');
    return db.all(
        `SELECT *
         FROM ${ARCHIVE_TABLE}
         WHERE id IN (${placeholders})
         ORDER BY source_rowid, id`,
        archiveIds
    );
}

async function triggerNames(db) {
    const rows = await db.all(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'trigger'
           AND name IN (?, ?)
         ORDER BY name`,
        [INSERT_TRIGGER, UPDATE_TRIGGER]
    );
    return (rows || []).map((row) => row.name).sort();
}

function parseArchivedRow(row) {
    let data;
    try {
        data = JSON.parse(row.row_json);
    } catch (error) {
        throw new BlankPlayerIdentityRestoreError(
            'Uma linha arquivada contém JSON inválido.',
            'invalid_archived_row_json',
            { archiveId: row.id, message: error.message }
        );
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new BlankPlayerIdentityRestoreError(
            'Uma linha arquivada não contém objeto válido.',
            'invalid_archived_row_payload',
            { archiveId: row.id }
        );
    }
    return data;
}

async function buildRestorePlan(db, evidence) {
    if (!await tableExists(db, 'jogadores')) {
        throw new BlankPlayerIdentityRestoreError('Tabela jogadores ausente.', 'players_table_missing');
    }
    if (!await tableExists(db, ARCHIVE_TABLE)) {
        throw new BlankPlayerIdentityRestoreError('Arquivo de placeholders ausente.', 'archive_table_missing');
    }

    const columns = await listPlayerColumns(db);
    if (!columns.length || !columns.includes('id')) {
        throw new BlankPlayerIdentityRestoreError('Schema de jogadores inválido.', 'players_schema_invalid');
    }

    const archiveRows = await readArchiveRows(db, evidence.archiveIds);
    if (archiveRows.length !== evidence.expectedCount) {
        throw new BlankPlayerIdentityRestoreError(
            'A quantidade arquivada não corresponde ao recibo.',
            'archive_row_count_mismatch',
            { expected: evidence.expectedCount, found: archiveRows.length }
        );
    }

    const normalized = archiveRows.map((archiveRow) => {
        const sourceRowid = Number(archiveRow.source_rowid);
        if (archiveRow.source_database_sha256 !== evidence.sourceDatabaseSha256) {
            throw new BlankPlayerIdentityRestoreError(
                'A origem da linha arquivada não corresponde ao recibo.',
                'archive_source_hash_mismatch',
                { archiveId: archiveRow.id }
            );
        }
        if (!evidence.sourceRowids.includes(sourceRowid)) {
            throw new BlankPlayerIdentityRestoreError(
                'Rowid arquivado não pertence ao recibo.',
                'archive_source_rowid_mismatch',
                { archiveId: archiveRow.id, sourceRowid }
            );
        }
        if (archiveRow.restored_at || archiveRow.restored_by || archiveRow.restore_reason) {
            throw new BlankPlayerIdentityRestoreError(
                'A linha arquivada já foi restaurada.',
                'archive_row_already_restored',
                { archiveId: archiveRow.id, sourceRowid }
            );
        }
        const data = parseArchivedRow(archiveRow);
        if (!isExactCacadorPlaceholder(data)) {
            throw new BlankPlayerIdentityRestoreError(
                'A assinatura arquivada não é mais um placeholder exato.',
                'archived_placeholder_signature_mismatch',
                { archiveId: archiveRow.id, sourceRowid }
            );
        }
        const dataColumns = Object.keys(data).sort();
        const schemaColumns = [...columns].sort();
        if (JSON.stringify(dataColumns) !== JSON.stringify(schemaColumns)) {
            throw new BlankPlayerIdentityRestoreError(
                'O schema atual difere do schema arquivado.',
                'archived_player_schema_mismatch',
                {
                    archiveId: archiveRow.id,
                    missingInArchive: schemaColumns.filter((column) => !dataColumns.includes(column)),
                    extraInArchive: dataColumns.filter((column) => !schemaColumns.includes(column)),
                }
            );
        }
        return {
            archiveId: Number(archiveRow.id),
            sourceRowid,
            data,
        };
    }).sort((a, b) => a.sourceRowid - b.sourceRowid);

    const foundRowids = normalized.map((row) => row.sourceRowid);
    if (JSON.stringify(foundRowids) !== JSON.stringify(evidence.sourceRowids)) {
        throw new BlankPlayerIdentityRestoreError(
            'Os rowids arquivados diferem do recibo.',
            'archive_rowid_set_mismatch',
            { expected: evidence.sourceRowids, found: foundRowids }
        );
    }

    const placeholders = foundRowids.map(() => '?').join(', ');
    const rowidConflict = await db.get(
        `SELECT COUNT(*) AS total
         FROM jogadores
         WHERE rowid IN (${placeholders})`,
        foundRowids
    );
    if (Number(rowidConflict?.total || 0) !== 0) {
        throw new BlankPlayerIdentityRestoreError(
            'Um rowid original já está ocupado.',
            'restore_rowid_conflict',
            { count: Number(rowidConflict?.total || 0) }
        );
    }

    const blankCount = await db.get(
        `SELECT COUNT(*) AS total
         FROM jogadores
         WHERE id IS NULL OR TRIM(CAST(id AS TEXT)) = ''`
    );
    if (Number(blankCount?.total || 0) !== 0) {
        throw new BlankPlayerIdentityRestoreError(
            'O banco limpo já contém identidades vazias.',
            'blank_identity_present_before_restore',
            { count: Number(blankCount?.total || 0) }
        );
    }

    const installedTriggers = await triggerNames(db);
    if (JSON.stringify(installedTriggers) !== JSON.stringify([INSERT_TRIGGER, UPDATE_TRIGGER].sort())) {
        throw new BlankPlayerIdentityRestoreError(
            'Os triggers de contenção não estão íntegros.',
            'containment_trigger_missing',
            { installedTriggers }
        );
    }

    return {
        write: false,
        safe: true,
        cleanedDatabaseSha256: evidence.cleanedDatabaseSha256,
        sourceDatabaseSha256: evidence.sourceDatabaseSha256,
        rowCount: normalized.length,
        rowids: foundRowids,
        columns,
        rows: normalized,
        triggers: installedTriggers,
    };
}

async function applyRestorePlan(db, plan, options = {}) {
    const actor = String(options.actor || '').trim();
    const reason = String(options.reason || '').trim().replace(/\s+/g, ' ');
    if (!actor) {
        throw new BlankPlayerIdentityRestoreError('Informe o responsável.', 'restore_actor_required');
    }
    if (reason.length < 8) {
        throw new BlankPlayerIdentityRestoreError('Informe um motivo detalhado.', 'restore_reason_required');
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        const freshPlan = await buildRestorePlan(db, {
            cleanedDatabaseSha256: plan.cleanedDatabaseSha256,
            sourceDatabaseSha256: plan.sourceDatabaseSha256,
            archiveIds: plan.rows.map((row) => row.archiveId),
            sourceRowids: plan.rowids,
            expectedCount: plan.rowCount,
        });

        await db.exec(`DROP TRIGGER IF EXISTS ${quoteIdentifier(INSERT_TRIGGER)}`);
        await db.exec(`DROP TRIGGER IF EXISTS ${quoteIdentifier(UPDATE_TRIGGER)}`);

        const quotedColumns = freshPlan.columns.map(quoteIdentifier).join(', ');
        const valuePlaceholders = freshPlan.columns.map(() => '?').join(', ');
        const restored = [];

        for (const row of freshPlan.rows) {
            const values = freshPlan.columns.map((column) => row.data[column]);
            const insertion = await db.run(
                `INSERT INTO jogadores (rowid, ${quotedColumns})
                 VALUES (?, ${valuePlaceholders})`,
                [row.sourceRowid, ...values]
            );
            if (Number(insertion?.changes || 0) !== 1) {
                throw new BlankPlayerIdentityRestoreError(
                    'Falha ao restaurar exatamente uma linha.',
                    'placeholder_restore_count_mismatch',
                    { archiveId: row.archiveId, sourceRowid: row.sourceRowid }
                );
            }
            const archiveUpdate = await db.run(
                `UPDATE ${ARCHIVE_TABLE}
                 SET restored_at = CURRENT_TIMESTAMP,
                     restored_by = ?,
                     restore_reason = ?
                 WHERE id = ?
                   AND restored_at IS NULL`,
                [actor, reason, row.archiveId]
            );
            if (Number(archiveUpdate?.changes || 0) !== 1) {
                throw new BlankPlayerIdentityRestoreError(
                    'Falha ao marcar o arquivo como restaurado.',
                    'archive_restore_marker_mismatch',
                    { archiveId: row.archiveId }
                );
            }
            restored.push({ archiveId: row.archiveId, sourceRowid: row.sourceRowid });
        }

        await ensureContainmentSchema(db);

        const blankCount = await db.get(
            `SELECT COUNT(*) AS total
             FROM jogadores
             WHERE id IS NULL OR TRIM(CAST(id AS TEXT)) = ''`
        );
        if (Number(blankCount?.total || 0) !== freshPlan.rowCount) {
            throw new BlankPlayerIdentityRestoreError(
                'A quantidade restaurada não corresponde ao plano.',
                'restored_blank_identity_count_mismatch',
                { expected: freshPlan.rowCount, found: Number(blankCount?.total || 0) }
            );
        }

        const restoredRows = await db.all(
            `SELECT rowid AS __rowid__, *
             FROM jogadores
             WHERE rowid IN (${freshPlan.rowids.map(() => '?').join(', ')})
             ORDER BY rowid`,
            freshPlan.rowids
        );
        if (restoredRows.length !== freshPlan.rowCount
            || restoredRows.some((row) => !isExactCacadorPlaceholder(row))) {
            throw new BlankPlayerIdentityRestoreError(
                'A assinatura restaurada não corresponde ao arquivo.',
                'restored_placeholder_signature_mismatch'
            );
        }

        const installedTriggers = await triggerNames(db);
        if (JSON.stringify(installedTriggers) !== JSON.stringify([INSERT_TRIGGER, UPDATE_TRIGGER].sort())) {
            throw new BlankPlayerIdentityRestoreError(
                'A contenção não foi reinstalada.',
                'containment_reinstall_failed',
                { installedTriggers }
            );
        }

        await db.exec('COMMIT');
        return {
            write: true,
            restoredCount: restored.length,
            restored,
            archiveRowsMarkedRestored: restored.length,
            containmentReinstalled: true,
            triggers: installedTriggers,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    BlankPlayerIdentityRestoreError,
    applyRestorePlan,
    buildRestorePlan,
    listPlayerColumns,
    parseArchivedRow,
    quoteIdentifier,
    triggerNames,
    validateCleanupReceipt,
};
