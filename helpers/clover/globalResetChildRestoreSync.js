'use strict';

const OP_TABLE = 'clover_global_player_reset_operations';
const ITEM_TABLE = 'clover_global_player_reset_items';
const LOCK_TABLE = 'clover_global_player_reset_lock';
const LOCK_KEY = 'global_character_reset';
const GLOBAL_CHILD_PREFIX = 'RS-G-';
const RESTORABLE_PARENT_STATUSES = Object.freeze(['paused', 'completed', 'reconciled']);
const RESTORABLE_ITEM_STATUSES = Object.freeze(['applied', 'reconciled']);

class GlobalResetChildRestoreSyncError extends Error {
    constructor(message, code = 'global_reset_child_restore_sync_error', details = null) {
        super(message || code);
        this.name = 'GlobalResetChildRestoreSyncError';
        this.code = code;
        this.details = details || null;
    }
}

function normalizeCode(value) {
    return String(value || '').trim().toUpperCase();
}

function isGlobalResetChildOperationCode(value) {
    return normalizeCode(value).startsWith(GLOBAL_CHILD_PREFIX);
}

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT 1 AS found FROM sqlite_schema WHERE type='table' AND name=? LIMIT 1`,
        [tableName]
    );
    return Boolean(row?.found);
}

async function resolveGlobalResetChildParent(db, resetOperationCode) {
    const code = normalizeCode(resetOperationCode);
    if (!isGlobalResetChildOperationCode(code)) {
        return Object.freeze({ globalChild: false, resetOperationCode: code, parent: null });
    }

    const hasItems = await tableExists(db, ITEM_TABLE);
    const hasOperations = await tableExists(db, OP_TABLE);
    const hasLock = await tableExists(db, LOCK_TABLE);
    if (!hasItems || !hasOperations || !hasLock) {
        throw new GlobalResetChildRestoreSyncError(
            'Child global não possui journal pai completo disponível.',
            'global_reset_child_restore_parent_journal_missing',
            { resetOperationCode: code, hasItems, hasOperations, hasLock }
        );
    }

    const parent = await db.get(
        `SELECT
            i.operation_id,
            i.player_id,
            i.status AS item_status,
            i.reset_operation_code,
            o.status AS operation_status,
            o.execution_token,
            o.expected_count,
            o.applied_count,
            o.failed_count,
            o.reconciled_count
         FROM ${ITEM_TABLE} i
         JOIN ${OP_TABLE} o ON o.operation_id=i.operation_id
         WHERE i.reset_operation_code=?`,
        [code]
    );
    if (!parent) {
        throw new GlobalResetChildRestoreSyncError(
            'Child global não está vinculado a uma operação pai.',
            'global_reset_child_restore_parent_missing',
            { resetOperationCode: code }
        );
    }
    return Object.freeze({ globalChild: true, resetOperationCode: code, parent: Object.freeze(parent) });
}

async function assertGlobalResetChildRestoreAllowed(db, { resetOperationCode, playerId = null } = {}) {
    const resolved = await resolveGlobalResetChildParent(db, resetOperationCode);
    if (!resolved.globalChild) return resolved;
    const parent = resolved.parent;

    if (playerId && String(parent.player_id) !== String(playerId)) {
        throw new GlobalResetChildRestoreSyncError(
            'Player do restore diverge do item global pai.',
            'global_reset_child_restore_player_mismatch',
            { resetOperationCode: resolved.resetOperationCode, expectedPlayerId: parent.player_id, actualPlayerId: playerId }
        );
    }

    const lock = await db.get(`SELECT * FROM ${LOCK_TABLE} WHERE lock_key=?`, [LOCK_KEY]);
    if (!lock) {
        throw new GlobalResetChildRestoreSyncError(
            'Restore de child global recusado: lock canônico do ciclo está ausente.',
            'global_reset_child_restore_cycle_lock_missing',
            { operationId: parent.operation_id }
        );
    }
    if (lock.operation_id !== parent.operation_id) {
        throw new GlobalResetChildRestoreSyncError(
            'Restore de child global recusado: lock canônico pertence a outra operação.',
            'global_reset_child_restore_cycle_lock_mismatch',
            { operationId: parent.operation_id, lockOperationId: lock.operation_id }
        );
    }

    if (parent.execution_token || parent.operation_status === 'running') {
        throw new GlobalResetChildRestoreSyncError(
            'Restore de child global é proibido enquanto o executor pai está ativo.',
            'global_reset_child_restore_parent_execution_active',
            {
                operationId: parent.operation_id,
                operationStatus: parent.operation_status,
                executionTokenPresent: Boolean(parent.execution_token),
            }
        );
    }
    if (!RESTORABLE_PARENT_STATUSES.includes(parent.operation_status)) {
        throw new GlobalResetChildRestoreSyncError(
            `Status pai inválido para restore de child global: ${parent.operation_status}.`,
            'global_reset_child_restore_parent_status_invalid',
            { operationId: parent.operation_id, operationStatus: parent.operation_status }
        );
    }
    if (!RESTORABLE_ITEM_STATUSES.includes(parent.item_status)) {
        throw new GlobalResetChildRestoreSyncError(
            `Status do item global inválido para restore: ${parent.item_status}.`,
            'global_reset_child_restore_item_status_invalid',
            { operationId: parent.operation_id, playerId: parent.player_id, itemStatus: parent.item_status }
        );
    }
    return resolved;
}

async function recomputeParentCounters(db, operationId) {
    const row = await db.get(
        `SELECT
            SUM(CASE WHEN status IN ('applied','reconciled') THEN 1 ELSE 0 END) AS applied_count,
            SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed_count,
            SUM(CASE WHEN status='reconciled' THEN 1 ELSE 0 END) AS reconciled_count
         FROM ${ITEM_TABLE}
         WHERE operation_id=?`,
        [operationId]
    );
    return Object.freeze({
        appliedCount: Number(row?.applied_count || 0),
        failedCount: Number(row?.failed_count || 0),
        reconciledCount: Number(row?.reconciled_count || 0),
    });
}

async function syncGlobalParentAfterChildRestore(db, {
    resetOperationCode,
    playerId,
    restoreOperationCode = null,
    actorId = null,
    reason = null,
    resolvedParent = null,
} = {}) {
    const resolved = resolvedParent || await assertGlobalResetChildRestoreAllowed(db, { resetOperationCode, playerId });
    if (!resolved.globalChild) return Object.freeze({ globalChild: false, parentUpdated: false });
    const parent = resolved.parent;
    const evidence = {
        code: 'global_child_reset_restored',
        playerId: parent.player_id,
        resetOperationCode: resolved.resetOperationCode,
        restoreOperationCode: restoreOperationCode || null,
        restoredBy: actorId || null,
        reason: reason || null,
    };

    const itemUpdate = await db.run(
        `UPDATE ${ITEM_TABLE}
         SET status='failed',last_error_json=?,finished_at=CURRENT_TIMESTAMP
         WHERE operation_id=? AND player_id=? AND reset_operation_code=?
           AND status IN ('applied','reconciled')`,
        [JSON.stringify(evidence), parent.operation_id, parent.player_id, resolved.resetOperationCode]
    );
    if (Number(itemUpdate?.changes || 0) !== 1) {
        throw new GlobalResetChildRestoreSyncError(
            'Item global pai não foi rebaixado exatamente uma vez após restore.',
            'global_reset_child_restore_item_compare_and_swap_failed',
            { operationId: parent.operation_id, playerId: parent.player_id, changes: Number(itemUpdate?.changes || 0) }
        );
    }

    const counts = await recomputeParentCounters(db, parent.operation_id);
    const operationUpdate = await db.run(
        `UPDATE ${OP_TABLE}
         SET status='paused',applied_count=?,failed_count=?,reconciled_count=?,
             completed_at=NULL,reconciled_at=NULL,last_error_json=?
         WHERE operation_id=? AND execution_token IS NULL
           AND status IN ('paused','completed','reconciled')`,
        [counts.appliedCount, counts.failedCount, counts.reconciledCount, JSON.stringify(evidence), parent.operation_id]
    );
    if (Number(operationUpdate?.changes || 0) !== 1) {
        throw new GlobalResetChildRestoreSyncError(
            'Operação global pai não foi rebaixada exatamente uma vez após restore.',
            'global_reset_child_restore_parent_compare_and_swap_failed',
            { operationId: parent.operation_id, changes: Number(operationUpdate?.changes || 0) }
        );
    }

    return Object.freeze({
        globalChild: true,
        parentUpdated: true,
        operationId: parent.operation_id,
        playerId: parent.player_id,
        status: 'paused',
        itemStatus: 'failed',
        counts,
    });
}

module.exports = {
    GLOBAL_CHILD_PREFIX,
    GlobalResetChildRestoreSyncError,
    RESTORABLE_ITEM_STATUSES,
    RESTORABLE_PARENT_STATUSES,
    assertGlobalResetChildRestoreAllowed,
    isGlobalResetChildOperationCode,
    resolveGlobalResetChildParent,
    syncGlobalParentAfterChildRestore,
};
