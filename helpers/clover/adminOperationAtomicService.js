'use strict';

const {
    AdminOperationServiceError,
    getOperationByCode,
} = require('./adminOperationServiceBase');
const {
    assertAtomicExecutors,
    getExecutor,
    operationExecutionPolicy,
} = require('./adminOperationPolicy');

function nowIso() {
    return new Date().toISOString();
}

function safeJson(value) {
    return value === undefined ? null : JSON.stringify(value);
}

function serializeError(error, fallbackCode) {
    return {
        code: error?.code || fallbackCode,
        message: error?.message || String(error),
        details: error?.details || null,
    };
}

async function appendEvent(db, operationId, eventType, options = {}) {
    await db.run(
        `INSERT INTO clover_admin_operation_events
         (operation_id, event_type, from_status, to_status, actor_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            operationId,
            eventType,
            options.fromStatus || null,
            options.toStatus || null,
            options.actorId || null,
            options.payload === undefined ? null : JSON.stringify(options.payload),
            options.createdAt || nowIso(),
        ]
    );
}

function assertAtomicOperation(operation, executors) {
    if (operationExecutionPolicy(operation) !== 'atomic') {
        throw new AdminOperationServiceError(
            'operation_not_atomic',
            'A operação não usa política atômica.',
            409,
            { code: operation.code }
        );
    }
    if (!operation.units?.length) {
        throw new AdminOperationServiceError(
            'operation_not_simulated',
            'A operação não possui unidades simuladas.',
            409,
            { code: operation.code }
        );
    }
    assertAtomicExecutors(operation.actions, executors);
}

async function recordAtomicFailure(db, operation, expectedStatus, actorId, failure, mode) {
    const timestamp = nowIso();
    const failedUnits = (operation.units || []).map((unit) => ({
        unitId: unit.id,
        code: unit.id === failure.unitId ? failure.error.code : 'atomic_rollback',
        message: unit.id === failure.unitId
            ? failure.error.message
            : 'Unidade não persistida porque a operação atômica foi revertida.',
        details: unit.id === failure.unitId ? failure.error.details : { failedUnitId: failure.unitId },
    }));
    const result = {
        executionPolicy: 'atomic',
        mode,
        appliedCount: 0,
        failedCount: failedUnits.length,
        totalCount: failedUnits.length,
        rolledBack: true,
        failure: { unitId: failure.unitId, ...failure.error },
        failures: failedUnits,
    };

    await db.exec('BEGIN IMMEDIATE');
    try {
        const changed = await db.run(
            `UPDATE clover_admin_operations
             SET status = 'failed', result_json = ?, error_json = ?, updated_at = ?
             WHERE id = ? AND status = ?`,
            [JSON.stringify(result), JSON.stringify({ failure: result.failure }), timestamp, operation.id, expectedStatus]
        );
        if (Number(changed.changes || 0) !== 1) {
            throw new AdminOperationServiceError(
                'operation_atomic_failure_conflict',
                'A operação mudou antes do registro da falha atômica.',
                409,
                { code: operation.code, expectedStatus }
            );
        }
        for (const unitFailure of failedUnits) {
            await db.run(
                `UPDATE clover_admin_operation_units
                 SET status = 'failed', error_json = ?, applied_at = NULL, undone_at = NULL
                 WHERE id = ?`,
                [JSON.stringify(unitFailure), unitFailure.unitId]
            );
        }
        await appendEvent(db, operation.id, 'atomic_failed', {
            fromStatus: expectedStatus,
            toStatus: 'failed',
            actorId,
            payload: result,
            createdAt: timestamp,
        });
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function runAtomicApply(db, code, actor, options = {}, mode = 'apply') {
    let operation = await getOperationByCode(db, code, { includeUnits: true, includeEvents: true });
    if (operation.status === 'applied') {
        return { ok: true, duplicate: true, operation };
    }

    const fromStatus = mode === 'retry' ? 'failed' : 'approved';
    const workingStatus = mode === 'retry' ? 'retrying' : 'applying';
    if (operation.status !== fromStatus) {
        throw new AdminOperationServiceError(
            mode === 'retry' ? 'operation_not_retryable' : 'invalid_operation_transition',
            `A operação ${operation.code} não pode iniciar ${mode} a partir de ${operation.status}.`,
            409,
            { code: operation.code, from: operation.status, expected: fromStatus }
        );
    }

    assertAtomicOperation(operation, options.executors);
    const startedAt = nowIso();
    let activeUnit = null;

    await db.exec('BEGIN IMMEDIATE');
    try {
        const claimed = await db.run(
            `UPDATE clover_admin_operations
             SET status = ?, applied_by = ?, updated_at = ?
             WHERE id = ? AND status = ?`,
            [workingStatus, actor?.id || null, startedAt, operation.id, fromStatus]
        );
        if (Number(claimed.changes || 0) !== 1) {
            throw new AdminOperationServiceError(
                'operation_recovery_conflict',
                'A operação mudou enquanto a execução atômica era iniciada.',
                409,
                { code: operation.code, expectedStatus: fromStatus }
            );
        }
        await appendEvent(db, operation.id, workingStatus, {
            fromStatus,
            toStatus: workingStatus,
            actorId: actor?.id || null,
            payload: { executionPolicy: 'atomic', mode },
            createdAt: startedAt,
        });

        let appliedCount = 0;
        for (const unit of operation.units) {
            activeUnit = unit;
            const action = operation.actions[unit.actionIndex];
            const executor = getExecutor(options.executors, unit.actionType);
            const metadata = unit.metadata || {};
            const target = metadata.target || { kind: 'player', playerId: unit.targetKey };
            const applied = await executor.apply({
                db,
                operation,
                action,
                target,
                unit,
                before: unit.before,
                after: unit.after,
            });
            const timestamp = nowIso();
            const changed = await db.run(
                `UPDATE clover_admin_operation_units
                 SET status = 'applied',
                     summary = COALESCE(?, summary),
                     before_json = ?,
                     after_json = ?,
                     metadata_json = ?,
                     error_json = NULL,
                     applied_at = ?,
                     undone_at = NULL
                 WHERE id = ? AND status IN ('planned', 'failed')`,
                [
                    applied?.summary || unit.summary,
                    safeJson(applied?.before ?? unit.before),
                    safeJson(applied?.after ?? unit.after),
                    JSON.stringify({ ...metadata, ...(applied?.metadata || {}), target }),
                    timestamp,
                    unit.id,
                ]
            );
            if (Number(changed.changes || 0) !== 1) {
                throw new AdminOperationServiceError(
                    'unit_atomic_conflict',
                    'Uma unidade mudou durante a aplicação atômica.',
                    409,
                    { unitId: unit.id }
                );
            }
            await appendEvent(db, operation.id, 'unit_applied_atomic', {
                actorId: actor?.id || null,
                payload: { unitId: unit.id, actionType: unit.actionType, targetKey: unit.targetKey },
                createdAt: timestamp,
            });
            appliedCount += 1;
        }

        const completedAt = nowIso();
        const result = {
            executionPolicy: 'atomic',
            mode,
            appliedCount,
            failedCount: 0,
            totalCount: operation.units.length,
            rolledBack: false,
        };
        const finalized = await db.run(
            `UPDATE clover_admin_operations
             SET status = 'applied', result_json = ?, error_json = NULL,
                 applied_at = ?, updated_at = ?
             WHERE id = ? AND status = ?`,
            [JSON.stringify(result), completedAt, completedAt, operation.id, workingStatus]
        );
        if (Number(finalized.changes || 0) !== 1) {
            throw new AdminOperationServiceError(
                'operation_recovery_conflict',
                'A operação mudou antes da conclusão atômica.',
                409,
                { code: operation.code, expectedStatus: workingStatus }
            );
        }
        await appendEvent(db, operation.id, 'applied', {
            fromStatus: workingStatus,
            toStatus: 'applied',
            actorId: actor?.id || null,
            payload: result,
            createdAt: completedAt,
        });
        await db.exec('COMMIT');
        return {
            ok: true,
            duplicate: false,
            operation: await getOperationByCode(db, code, { includeUnits: true, includeEvents: true }),
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        const serialized = serializeError(error, mode === 'retry' ? 'atomic_retry_failed' : 'atomic_apply_failed');
        const failure = { unitId: activeUnit?.id || null, error: serialized };
        operation = await getOperationByCode(db, code, { includeUnits: true, includeEvents: true });
        await recordAtomicFailure(db, operation, fromStatus, actor?.id || null, failure, mode);
        return {
            ok: false,
            duplicate: false,
            operation: await getOperationByCode(db, code, { includeUnits: true, includeEvents: true }),
        };
    }
}

async function applyAtomicAdminOperation(db, code, actor, options = {}) {
    return runAtomicApply(db, code, actor, options, 'apply');
}

async function retryAtomicAdminOperation(db, code, actor, options = {}) {
    return runAtomicApply(db, code, actor, options, 'retry');
}

async function compensateAtomicAdminOperation(db, code, actor, options = {}) {
    let operation = await getOperationByCode(db, code, { includeUnits: true, includeEvents: true });
    if (operation.status === 'compensated' || operation.status === 'undone') {
        return { ok: true, duplicate: true, operation };
    }
    if (operation.status !== 'applied') {
        throw new AdminOperationServiceError(
            'operation_not_compensatable',
            'A operação atômica precisa estar aplicada para ser compensada.',
            409,
            { code: operation.code, status: operation.status }
        );
    }
    assertAtomicOperation(operation, options.executors);
    const units = [...operation.units].sort((left, right) => (
        right.actionIndex - left.actionIndex
        || right.targetIndex - left.targetIndex
        || right.id - left.id
    ));
    const startedAt = nowIso();
    let activeUnit = null;

    await db.exec('BEGIN IMMEDIATE');
    try {
        const claimed = await db.run(
            `UPDATE clover_admin_operations SET status = 'compensating', updated_at = ?
             WHERE id = ? AND status = 'applied'`,
            [startedAt, operation.id]
        );
        if (Number(claimed.changes || 0) !== 1) {
            throw new AdminOperationServiceError(
                'operation_recovery_conflict',
                'A operação mudou enquanto a compensação atômica era iniciada.',
                409,
                { code: operation.code }
            );
        }
        await appendEvent(db, operation.id, 'compensating', {
            fromStatus: 'applied',
            toStatus: 'compensating',
            actorId: actor?.id || null,
            payload: { executionPolicy: 'atomic' },
            createdAt: startedAt,
        });

        for (const unit of units) {
            activeUnit = unit;
            const action = operation.actions[unit.actionIndex];
            const executor = getExecutor(options.executors, unit.actionType);
            if (!executor?.undo) {
                throw new AdminOperationServiceError(
                    'action_not_undoable',
                    `A ação ${unit.actionType} não pode ser compensada.`,
                    409,
                    { unitId: unit.id }
                );
            }
            const target = unit.metadata?.target || { kind: 'player', playerId: unit.targetKey };
            await executor.undo({
                db,
                operation,
                action,
                target,
                unit,
                before: unit.before,
                after: unit.after,
            });
            const timestamp = nowIso();
            const changed = await db.run(
                `UPDATE clover_admin_operation_units
                 SET status = 'compensated', error_json = NULL, undone_at = ?
                 WHERE id = ? AND status = 'applied'`,
                [timestamp, unit.id]
            );
            if (Number(changed.changes || 0) !== 1) {
                throw new AdminOperationServiceError(
                    'unit_atomic_conflict',
                    'Uma unidade mudou durante a compensação atômica.',
                    409,
                    { unitId: unit.id }
                );
            }
            await appendEvent(db, operation.id, 'unit_compensated_atomic', {
                actorId: actor?.id || null,
                payload: { unitId: unit.id, actionType: unit.actionType, targetKey: unit.targetKey },
                createdAt: timestamp,
            });
        }

        const completedAt = nowIso();
        const result = {
            executionPolicy: 'atomic',
            recovery: 'compensate',
            compensatedCount: units.length,
            remainingAppliedCount: 0,
            totalCount: units.length,
        };
        const finalized = await db.run(
            `UPDATE clover_admin_operations
             SET status = 'compensated', result_json = ?, error_json = NULL,
                 undone_by = ?, undone_at = ?, updated_at = ?
             WHERE id = ? AND status = 'compensating'`,
            [JSON.stringify(result), actor?.id || null, completedAt, completedAt, operation.id]
        );
        if (Number(finalized.changes || 0) !== 1) {
            throw new AdminOperationServiceError(
                'operation_recovery_conflict',
                'A operação mudou antes da conclusão da compensação atômica.',
                409,
                { code: operation.code }
            );
        }
        await appendEvent(db, operation.id, 'compensated', {
            fromStatus: 'compensating',
            toStatus: 'compensated',
            actorId: actor?.id || null,
            payload: result,
            createdAt: completedAt,
        });
        await db.exec('COMMIT');
        return {
            ok: true,
            duplicate: false,
            operation: await getOperationByCode(db, code, { includeUnits: true, includeEvents: true }),
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        const serialized = serializeError(error, 'atomic_compensation_failed');
        const timestamp = nowIso();
        operation = await getOperationByCode(db, code, { includeUnits: true, includeEvents: true });
        await db.exec('BEGIN IMMEDIATE');
        try {
            const changed = await db.run(
                `UPDATE clover_admin_operations
                 SET status = 'applied', error_json = ?, updated_at = ?
                 WHERE id = ? AND status = 'applied'`,
                [JSON.stringify({ failure: { unitId: activeUnit?.id || null, ...serialized } }), timestamp, operation.id]
            );
            if (Number(changed.changes || 0) !== 1) {
                throw new AdminOperationServiceError(
                    'operation_atomic_failure_conflict',
                    'A operação mudou antes do registro da falha de compensação.',
                    409,
                    { code: operation.code }
                );
            }
            await appendEvent(db, operation.id, 'atomic_compensation_failed', {
                fromStatus: 'applied',
                toStatus: 'applied',
                actorId: actor?.id || null,
                payload: { unitId: activeUnit?.id || null, ...serialized },
                createdAt: timestamp,
            });
            await db.exec('COMMIT');
        } catch (recordError) {
            await db.exec('ROLLBACK').catch(() => null);
            throw recordError;
        }
        return {
            ok: false,
            duplicate: false,
            operation: await getOperationByCode(db, code, { includeUnits: true, includeEvents: true }),
        };
    }
}

module.exports = {
    applyAtomicAdminOperation,
    compensateAtomicAdminOperation,
    retryAtomicAdminOperation,
};
