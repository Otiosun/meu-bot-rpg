'use strict';

const { isOwner, normalizeJid } = require('../groupAccess');
const {
    ensureGlobalPlayerResetSchema,
    inspectFrozenJournalIntegrity,
    inspectGlobalResetCycleLock,
    snapshotHash,
} = require('./globalPlayerResetService');
const { inspectChildResetEventBinding } = require('./globalPlayerResetEventBinding');

const OP_TABLE = 'clover_global_player_reset_operations';
const ITEM_TABLE = 'clover_global_player_reset_items';

class GlobalPlayerResetRecoveryError extends Error {
    constructor(message, code = 'global_reset_recovery_error', details = null) {
        super(message || code);
        this.name = 'GlobalPlayerResetRecoveryError';
        this.code = code;
        this.details = details || null;
    }
}

function assertRecoveryAuthorization(operationId, actorId) {
    if (!isOwner(actorId)) {
        throw new GlobalPlayerResetRecoveryError(
            'Recovery de reset global exige Owner canônico.',
            'global_reset_recovery_permission_denied'
        );
    }
    if (String(process.env.CLOVER_GLOBAL_RESET_ENABLED || '').trim().toUpperCase() !== 'YES') {
        throw new GlobalPlayerResetRecoveryError(
            'Kill switch global está OFF.',
            'global_reset_kill_switch_off'
        );
    }
    if (String(process.env.CLOVER_GLOBAL_RESET_OPERATION_ID || '').trim() !== operationId) {
        throw new GlobalPlayerResetRecoveryError(
            'Operation ID não está pinado no ambiente.',
            'global_reset_operation_not_pinned'
        );
    }
    if (String(process.env.CLOVER_GLOBAL_RESET_RECOVER_EXECUTION || '').trim().toUpperCase() !== 'YES') {
        throw new GlobalPlayerResetRecoveryError(
            'Recovery de executor está OFF.',
            'global_reset_recovery_switch_off'
        );
    }
}

async function refreshCounters(db, operationId) {
    const row = await db.get(`
        SELECT
            SUM(CASE WHEN status <> 'skipped' THEN 1 ELSE 0 END) AS expected_count,
            SUM(CASE WHEN status IN ('applied','reconciled') THEN 1 ELSE 0 END) AS applied_count,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
            SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count,
            SUM(CASE WHEN status = 'reconciled' THEN 1 ELSE 0 END) AS reconciled_count
        FROM ${ITEM_TABLE}
        WHERE operation_id = ?`,
        [operationId]
    );
    const counts = {
        expectedCount: Number(row?.expected_count || 0),
        appliedCount: Number(row?.applied_count || 0),
        failedCount: Number(row?.failed_count || 0),
        skippedCount: Number(row?.skipped_count || 0),
        reconciledCount: Number(row?.reconciled_count || 0),
    };
    await db.run(
        `UPDATE ${OP_TABLE}
         SET applied_count=?, failed_count=?, reconciled_count=?
         WHERE operation_id=?`,
        [counts.appliedCount, counts.failedCount, counts.reconciledCount, operationId]
    );
    return counts;
}

function assertRecoveryJournalIntegrity(operation, items) {
    const integrity = inspectFrozenJournalIntegrity(operation, items);
    if (!integrity.countersMatch) {
        throw new GlobalPlayerResetRecoveryError(
            'Recovery recusado: contadores congelados divergiram do journal.',
            'global_reset_recovery_frozen_counter_drift',
            { frozen: integrity.frozenCounters, observed: integrity.observedCounters }
        );
    }
    if (integrity.emptyEffectivePopulation) {
        throw new GlobalPlayerResetRecoveryError(
            'Recovery recusado: operação sem população efetiva.',
            'global_reset_recovery_empty_effective_population',
            integrity.observedCounters
        );
    }
    if (!integrity.populationHashMatch) {
        throw new GlobalPlayerResetRecoveryError(
            'Recovery recusado: journal divergiu do population hash.',
            'global_reset_recovery_population_journal_drift',
            { frozen: integrity.frozenPopulationHash, observed: integrity.observedPopulationHash }
        );
    }
    return integrity;
}

async function assertRecoveryCycleLock(db, operationId) {
    const lockState = await inspectGlobalResetCycleLock(db, operationId);
    if (lockState.ok) return lockState.lock;
    throw new GlobalPlayerResetRecoveryError(
        lockState.code === 'global_reset_cycle_lock_missing'
            ? 'Recovery recusado: lock canônico do ciclo está ausente.'
            : `Recovery recusado: lock canônico pertence a ${lockState.lockOperationId}.`,
        lockState.code === 'global_reset_cycle_lock_missing'
            ? 'global_reset_recovery_cycle_lock_missing'
            : 'global_reset_recovery_cycle_lock_mismatch',
        lockState
    );
}

async function recoverGlobalPlayerResetExecution(db, {
    operationId,
    actorId,
    expectedExecutionToken,
} = {}) {
    const id = String(operationId || '').trim();
    const expectedToken = String(expectedExecutionToken || '').trim();
    if (!id) {
        throw new GlobalPlayerResetRecoveryError(
            'operationId obrigatório.',
            'global_reset_operation_id_required'
        );
    }
    if (!expectedToken) {
        throw new GlobalPlayerResetRecoveryError(
            'Token de executor esperado é obrigatório.',
            'global_reset_recovery_token_required'
        );
    }
    assertRecoveryAuthorization(id, actorId);
    await ensureGlobalPlayerResetSchema(db);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const operation = await db.get(`SELECT * FROM ${OP_TABLE} WHERE operation_id=?`, [id]);
        if (!operation) {
            throw new GlobalPlayerResetRecoveryError(
                'Operação global não encontrada.',
                'global_reset_operation_not_found'
            );
        }
        if (operation.status !== 'running') {
            throw new GlobalPlayerResetRecoveryError(
                `Recovery exige operação running; atual=${operation.status}.`,
                'global_reset_recovery_invalid_status',
                { status: operation.status }
            );
        }
        if (!operation.execution_token) {
            throw new GlobalPlayerResetRecoveryError(
                'Não há execution_token para recuperar.',
                'global_reset_no_execution_lock'
            );
        }
        if (operation.execution_token !== expectedToken) {
            throw new GlobalPlayerResetRecoveryError(
                'execution_token mudou desde a inspeção; recovery recusado.',
                'global_reset_recovery_token_mismatch',
                { expected: expectedToken, actual: operation.execution_token }
            );
        }

        await assertRecoveryCycleLock(db, id);
        const allItems = await db.all(
            `SELECT * FROM ${ITEM_TABLE} WHERE operation_id=? ORDER BY ordinal`,
            [id]
        );
        assertRecoveryJournalIntegrity(operation, allItems);

        const processing = allItems.filter((item) => item.status === 'processing');
        for (const item of processing) {
            const event = await db.get(
                `SELECT operation_code, player_id, scope, status, before_json, result_json
                 FROM clover_player_reset_events
                 WHERE operation_code=?`,
                [item.reset_operation_code]
            );
            if (!event) {
                await db.run(
                    `UPDATE ${ITEM_TABLE}
                     SET status='pending', last_error_json=?
                     WHERE operation_id=? AND player_id=?`,
                    [
                        JSON.stringify({
                            code: 'recovered_processing_without_event',
                            previousExecutionToken: expectedToken,
                        }),
                        id,
                        item.player_id,
                    ]
                );
                continue;
            }
            const binding = inspectChildResetEventBinding(item, event, { snapshotHash });
            if (!binding.ok) {
                throw new GlobalPlayerResetRecoveryError(
                    'Evento filho não está vinculado ao dry-run congelado durante recovery.',
                    'global_reset_recovery_event_binding_mismatch',
                    { playerId: item.player_id, binding }
                );
            }
            await db.run(
                `UPDATE ${ITEM_TABLE}
                 SET status='reconciled', result_json=?, last_error_json=NULL,
                     finished_at=CURRENT_TIMESTAMP
                 WHERE operation_id=? AND player_id=?`,
                [event.result_json || null, id, item.player_id]
            );
        }

        const counts = await refreshCounters(db, id);
        const result = await db.run(
            `UPDATE ${OP_TABLE}
             SET status='paused', execution_token=NULL, last_error_json=?
             WHERE operation_id=? AND execution_token=? AND status='running'`,
            [
                JSON.stringify({
                    code: 'orphan_execution_recovered',
                    recoveredBy: normalizeJid(actorId) || String(actorId),
                    previousExecutionToken: expectedToken,
                }),
                id,
                expectedToken,
            ]
        );
        if (Number(result?.changes || 0) !== 1) {
            throw new GlobalPlayerResetRecoveryError(
                'execution_token/status mudou durante recovery; nada foi liberado.',
                'global_reset_recovery_compare_and_swap_failed'
            );
        }
        await db.exec('COMMIT');
        return {
            ok: true,
            operationId: id,
            status: 'paused',
            previousExecutionToken: expectedToken,
            ...counts,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    GlobalPlayerResetRecoveryError,
    recoverGlobalPlayerResetExecution,
};
