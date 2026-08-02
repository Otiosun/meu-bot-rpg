'use strict';

const {
    AdminOperationServiceError,
    getOperationByCode,
} = require('./adminOperationService');

function nowIso() {
    return new Date().toISOString();
}

function getExecutor(registry, actionType) {
    if (!registry) return null;
    if (registry instanceof Map) return registry.get(actionType) || null;
    return registry[actionType] || null;
}

function serializeError(error, fallbackCode) {
    return {
        code: error?.code || fallbackCode,
        message: error?.message || String(error),
        details: error?.details || null,
    };
}

async function appendRecoveryEvent(db, operationId, eventType, options = {}) {
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

async function claimRecoveryState(db, operation, fromStatuses, toStatus, actorId) {
    const timestamp = nowIso();
    const placeholders = fromStatuses.map(() => '?').join(', ');
    await db.exec('BEGIN IMMEDIATE');
    try {
        const updated = await db.run(
            `UPDATE clover_admin_operations
             SET status = ?, updated_at = ?
             WHERE id = ? AND status IN (${placeholders})`,
            [toStatus, timestamp, operation.id, ...fromStatuses]
        );
        if (Number(updated.changes || 0) !== 1) {
            const current = await getOperationByCode(db, operation.code, { includeUnits: true });
            throw new AdminOperationServiceError(
                'operation_recovery_conflict',
                'A operação mudou enquanto a recuperação era iniciada.',
                409,
                {
                    code: operation.code,
                    expectedStatuses: fromStatuses,
                    currentStatus: current.status,
                }
            );
        }
        await appendRecoveryEvent(db, operation.id, toStatus, {
            fromStatus: operation.status,
            toStatus,
            actorId,
            createdAt: timestamp,
        });
        await db.exec('COMMIT');
        return timestamp;
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

function summarizeUnits(units) {
    const counts = {};
    for (const unit of units || []) {
        counts[unit.status] = Number(counts[unit.status] || 0) + 1;
    }
    return counts;
}

async function finalizeRecovery(db, operation, workingStatus, finalStatus, actorId, result) {
    const timestamp = nowIso();
    await db.exec('BEGIN IMMEDIATE');
    try {
        const updated = await db.run(
            `UPDATE clover_admin_operations
             SET status = ?, result_json = ?, error_json = ?, updated_at = ?
             WHERE id = ? AND status = ?`,
            [
                finalStatus,
                JSON.stringify(result),
                result.failures?.length ? JSON.stringify({ failures: result.failures }) : null,
                timestamp,
                operation.id,
                workingStatus,
            ]
        );
        if (Number(updated.changes || 0) !== 1) {
            throw new AdminOperationServiceError(
                'operation_recovery_conflict',
                'A operação mudou antes da conclusão da recuperação.',
                409,
                { code: operation.code, expectedStatus: workingStatus }
            );
        }
        await appendRecoveryEvent(db, operation.id, finalStatus, {
            fromStatus: workingStatus,
            toStatus: finalStatus,
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

async function retryAdminOperation(db, code, actor, options = {}) {
    let operation = await getOperationByCode(db, code, { includeUnits: true, includeEvents: true });
    if (operation.status === 'applied') {
        return { ok: true, duplicate: true, operation };
    }
    if (!['partially_applied', 'failed'].includes(operation.status)) {
        throw new AdminOperationServiceError(
            'operation_not_retryable',
            'A operação não está em estado recuperável por retry.',
            409,
            { code: operation.code, status: operation.status }
        );
    }

    const failedUnits = (operation.units || []).filter((unit) => unit.status === 'failed');
    if (!failedUnits.length) {
        throw new AdminOperationServiceError(
            'nothing_to_retry',
            'A operação não possui unidades falhas para retentar.',
            409,
            { code: operation.code }
        );
    }

    await claimRecoveryState(
        db,
        operation,
        ['partially_applied', 'failed'],
        'retrying',
        actor?.id || null
    );

    const failures = [];
    let retriedCount = 0;
    for (const unit of failedUnits) {
        const action = operation.actions[unit.actionIndex];
        const executor = getExecutor(options.executors, unit.actionType);
        if (!executor?.apply) {
            const error = {
                code: 'action_not_implemented',
                message: `Ação sem executor: ${unit.actionType}.`,
                details: null,
            };
            failures.push({ unitId: unit.id, ...error });
            await db.run(
                `UPDATE clover_admin_operation_units
                 SET status = 'failed', error_json = ?
                 WHERE id = ? AND status = 'failed'`,
                [JSON.stringify(error), unit.id]
            );
            continue;
        }

        const metadata = unit.metadata || {};
        const target = metadata.target || { kind: 'player', playerId: unit.targetKey };
        const savepoint = `admin_op_retry_${unit.id}`;
        await db.exec(`SAVEPOINT ${savepoint}`);
        try {
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
            const updated = await db.run(
                `UPDATE clover_admin_operation_units
                 SET status = 'applied',
                     summary = COALESCE(?, summary),
                     before_json = ?,
                     after_json = ?,
                     metadata_json = ?,
                     error_json = NULL,
                     applied_at = ?,
                     undone_at = NULL
                 WHERE id = ? AND status = 'failed'`,
                [
                    applied?.summary || unit.summary,
                    JSON.stringify(applied?.before ?? unit.before),
                    JSON.stringify(applied?.after ?? unit.after),
                    JSON.stringify({ ...metadata, ...(applied?.metadata || {}), target }),
                    timestamp,
                    unit.id,
                ]
            );
            if (Number(updated.changes || 0) !== 1) {
                throw new AdminOperationServiceError(
                    'unit_recovery_conflict',
                    'A unidade mudou durante o retry.',
                    409,
                    { unitId: unit.id }
                );
            }
            await appendRecoveryEvent(db, operation.id, 'unit_retried', {
                actorId: actor?.id || null,
                payload: { unitId: unit.id, actionType: unit.actionType, targetKey: unit.targetKey },
                createdAt: timestamp,
            });
            await db.exec(`RELEASE SAVEPOINT ${savepoint}`);
            retriedCount += 1;
        } catch (error) {
            await db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            const serialized = serializeError(error, 'action_retry_failed');
            failures.push({ unitId: unit.id, ...serialized });
            await db.run(
                `UPDATE clover_admin_operation_units
                 SET status = 'failed', error_json = ?
                 WHERE id = ?`,
                [JSON.stringify(serialized), unit.id]
            );
            await appendRecoveryEvent(db, operation.id, 'unit_retry_failed', {
                actorId: actor?.id || null,
                payload: { unitId: unit.id, ...serialized },
            });
            await db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }
    }

    operation = await getOperationByCode(db, code, { includeUnits: true });
    const counts = summarizeUnits(operation.units);
    const appliedCount = Number(counts.applied || 0);
    const failedCount = Number(counts.failed || 0);
    const finalStatus = failedCount === 0
        ? 'applied'
        : appliedCount > 0
            ? 'partially_applied'
            : 'failed';
    const result = {
        recovery: 'retry',
        retriedCount,
        appliedCount,
        failedCount,
        totalCount: (operation.units || []).length,
        failures,
    };
    await finalizeRecovery(
        db,
        operation,
        'retrying',
        finalStatus,
        actor?.id || null,
        result
    );
    return {
        ok: finalStatus !== 'failed',
        duplicate: false,
        operation: await getOperationByCode(db, code, { includeUnits: true, includeEvents: true }),
    };
}

async function compensateAdminOperation(db, code, actor, options = {}) {
    let operation = await getOperationByCode(db, code, { includeUnits: true, includeEvents: true });
    if (operation.status === 'compensated' || operation.status === 'undone') {
        return { ok: true, duplicate: true, operation };
    }
    if (!['partially_applied', 'applied'].includes(operation.status)) {
        throw new AdminOperationServiceError(
            'operation_not_compensatable',
            'A operação não está em estado compensável.',
            409,
            { code: operation.code, status: operation.status }
        );
    }

    const appliedUnits = (operation.units || [])
        .filter((unit) => unit.status === 'applied')
        .sort((left, right) => (
            right.actionIndex - left.actionIndex
            || right.targetIndex - left.targetIndex
            || right.id - left.id
        ));
    if (!appliedUnits.length) {
        throw new AdminOperationServiceError(
            'nothing_to_compensate',
            'A operação não possui unidades aplicadas para compensar.',
            409,
            { code: operation.code }
        );
    }

    await claimRecoveryState(
        db,
        operation,
        ['partially_applied', 'applied'],
        'compensating',
        actor?.id || null
    );

    const failures = [];
    let compensatedCount = 0;
    for (const unit of appliedUnits) {
        const action = operation.actions[unit.actionIndex];
        const executor = getExecutor(options.executors, unit.actionType);
        if (!executor?.undo) {
            const error = {
                code: 'action_not_undoable',
                message: `A ação ${unit.actionType} não pode ser compensada.`,
                details: { unitId: unit.id },
            };
            failures.push({ unitId: unit.id, ...error });
            await db.run(
                `UPDATE clover_admin_operation_units SET error_json = ? WHERE id = ?`,
                [JSON.stringify(error), unit.id]
            );
            continue;
        }

        const target = unit.metadata?.target || { kind: 'player', playerId: unit.targetKey };
        const savepoint = `admin_op_compensate_${unit.id}`;
        await db.exec(`SAVEPOINT ${savepoint}`);
        try {
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
            const updated = await db.run(
                `UPDATE clover_admin_operation_units
                 SET status = 'compensated', error_json = NULL, undone_at = ?
                 WHERE id = ? AND status = 'applied'`,
                [timestamp, unit.id]
            );
            if (Number(updated.changes || 0) !== 1) {
                throw new AdminOperationServiceError(
                    'unit_recovery_conflict',
                    'A unidade mudou durante a compensação.',
                    409,
                    { unitId: unit.id }
                );
            }
            await appendRecoveryEvent(db, operation.id, 'unit_compensated', {
                actorId: actor?.id || null,
                payload: { unitId: unit.id, actionType: unit.actionType, targetKey: unit.targetKey },
                createdAt: timestamp,
            });
            await db.exec(`RELEASE SAVEPOINT ${savepoint}`);
            compensatedCount += 1;
        } catch (error) {
            await db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            const serialized = serializeError(error, 'action_compensation_failed');
            failures.push({ unitId: unit.id, ...serialized });
            await db.run(
                `UPDATE clover_admin_operation_units SET error_json = ? WHERE id = ?`,
                [JSON.stringify(serialized), unit.id]
            );
            await appendRecoveryEvent(db, operation.id, 'unit_compensation_failed', {
                actorId: actor?.id || null,
                payload: { unitId: unit.id, ...serialized },
            });
            await db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }
    }

    operation = await getOperationByCode(db, code, { includeUnits: true });
    const counts = summarizeUnits(operation.units);
    const remainingAppliedCount = Number(counts.applied || 0);
    const finalStatus = remainingAppliedCount === 0 ? 'compensated' : 'partially_applied';
    const result = {
        recovery: 'compensate',
        compensatedCount,
        remainingAppliedCount,
        totalCount: (operation.units || []).length,
        failures,
    };
    await finalizeRecovery(
        db,
        operation,
        'compensating',
        finalStatus,
        actor?.id || null,
        result
    );
    return {
        ok: finalStatus === 'compensated',
        duplicate: false,
        operation: await getOperationByCode(db, code, { includeUnits: true, includeEvents: true }),
    };
}

async function acceptPartialAdminOperation(db, code, actor, justification) {
    const operation = await getOperationByCode(db, code, { includeUnits: true, includeEvents: true });
    if (operation.status === 'accepted_partial') {
        return { ok: true, duplicate: true, operation };
    }
    if (operation.status !== 'partially_applied') {
        throw new AdminOperationServiceError(
            'operation_not_partially_applied',
            'Apenas operações parcialmente aplicadas podem ser aceitas como parciais.',
            409,
            { code: operation.code, status: operation.status }
        );
    }

    const cleanJustification = String(justification || '').trim();
    if (!cleanJustification) {
        throw new AdminOperationServiceError(
            'partial_acceptance_reason_required',
            'Informe a justificativa para aceitar a aplicação parcial.',
            400,
            { code: operation.code }
        );
    }

    const timestamp = nowIso();
    const receipt = {
        recovery: 'accept_partial',
        acceptedBy: actor?.id || null,
        acceptedAt: timestamp,
        justification: cleanJustification,
        unitCounts: summarizeUnits(operation.units),
    };
    await db.exec('BEGIN IMMEDIATE');
    try {
        const updated = await db.run(
            `UPDATE clover_admin_operations
             SET status = 'accepted_partial',
                 result_json = ?,
                 error_json = NULL,
                 updated_at = ?
             WHERE id = ? AND status = 'partially_applied'`,
            [JSON.stringify(receipt), timestamp, operation.id]
        );
        if (Number(updated.changes || 0) !== 1) {
            throw new AdminOperationServiceError(
                'operation_recovery_conflict',
                'A operação mudou antes do aceite parcial.',
                409,
                { code: operation.code }
            );
        }
        await appendRecoveryEvent(db, operation.id, 'accepted_partial', {
            fromStatus: 'partially_applied',
            toStatus: 'accepted_partial',
            actorId: actor?.id || null,
            payload: receipt,
            createdAt: timestamp,
        });
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
    return {
        ok: true,
        duplicate: false,
        operation: await getOperationByCode(db, code, { includeUnits: true, includeEvents: true }),
    };
}

module.exports = {
    acceptPartialAdminOperation,
    compensateAdminOperation,
    retryAdminOperation,
};
