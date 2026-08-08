'use strict';

const {
    AdminOperationServiceError,
    ensureAdminOperationSchema,
    getOperationByCode,
} = require('./adminOperationServiceBase');
const { canTransitionOperation } = require('./adminOperationContract');

function nowIso() {
    return new Date().toISOString();
}

function getExecutor(registry, actionType) {
    if (!registry) return null;
    if (registry instanceof Map) return registry.get(actionType) || null;
    return registry[actionType] || null;
}

function isSystemOperation(operation) {
    const targets = Array.isArray(operation?.targets) ? operation.targets : [];
    return targets.length > 0 && targets.every((target) => target?.kind === 'system' && target?.systemKey === 'clover');
}

async function appendSimulationEvent(db, operationId, actorId, targetCount, unitCount, timestamp) {
    await db.run(
        `INSERT INTO clover_admin_operation_events
         (operation_id, event_type, from_status, to_status, actor_id, payload_json, created_at)
         VALUES (?, 'simulated', 'draft', 'simulated', ?, ?, ?)`,
        [operationId, actorId || null, JSON.stringify({ targetCount, unitCount, scope: 'system' }), timestamp]
    );
}

async function simulateSystemAdminOperation(db, code, actor, options = {}) {
    await ensureAdminOperationSchema(db);
    const operation = await getOperationByCode(db, code, { includeEvents: true });
    if (!isSystemOperation(operation)) return null;
    if (operation.status === 'simulated') {
        return { ok: true, duplicate: true, operation: await getOperationByCode(db, code, { includeEvents: true, includeUnits: true }) };
    }
    if (!canTransitionOperation(operation.status, 'simulated')) {
        throw new AdminOperationServiceError(
            'invalid_operation_transition',
            `Não é possível mover ${operation.code} de ${operation.status} para simulated.`,
            409,
            { code: operation.code, from: operation.status, to: 'simulated' }
        );
    }

    const targets = [{
        kind: 'system',
        systemKey: 'clover',
        label: 'Clover RPG',
        source: 'system',
    }];
    const units = [];
    for (let actionIndex = 0; actionIndex < operation.actions.length; actionIndex += 1) {
        const action = operation.actions[actionIndex];
        const executor = getExecutor(options.executors, action.type);
        if (!executor?.preview) {
            throw new AdminOperationServiceError(
                'action_not_implemented',
                `A ação ${action.type} ainda não possui executor.`,
                501,
                { actionType: action.type }
            );
        }
        const target = targets[0];
        const preview = await executor.preview({
            db,
            operation,
            action,
            target,
            actionIndex,
            targetIndex: 0,
        });
        units.push({
            actionIndex,
            targetIndex: 0,
            actionType: action.type,
            targetKey: 'system:clover',
            target,
            summary: preview?.summary || action.label || action.type,
            before: preview?.before ?? null,
            after: preview?.after ?? null,
            metadata: preview?.metadata || {},
        });
    }

    const timestamp = nowIso();
    await db.exec('BEGIN IMMEDIATE');
    try {
        await db.run('DELETE FROM clover_admin_operation_units WHERE operation_id = ?', [operation.id]);
        for (const unit of units) {
            await db.run(
                `INSERT INTO clover_admin_operation_units
                 (operation_id, action_index, target_index, action_type, target_key, status,
                  summary, before_json, after_json, metadata_json)
                 VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?)`,
                [
                    operation.id,
                    unit.actionIndex,
                    unit.targetIndex,
                    unit.actionType,
                    unit.targetKey,
                    unit.summary,
                    JSON.stringify(unit.before),
                    JSON.stringify(unit.after),
                    JSON.stringify({ ...unit.metadata, target: unit.target }),
                ]
            );
        }
        const preview = {
            targetCount: 1,
            unitCount: units.length,
            targets,
            units,
            warnings: [],
        };
        const updated = await db.run(
            `UPDATE clover_admin_operations
             SET status = 'simulated', preview_json = ?, simulated_at = ?, updated_at = ?, error_json = NULL
             WHERE id = ? AND status = 'draft'`,
            [JSON.stringify(preview), timestamp, timestamp, operation.id]
        );
        if (!Number(updated?.changes || 0)) {
            throw new AdminOperationServiceError(
                'operation_changed_during_simulation',
                'A operação mudou durante a simulação global.',
                409,
                { code: operation.code }
            );
        }
        await appendSimulationEvent(db, operation.id, actor?.id, 1, units.length, timestamp);
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }

    return {
        ok: true,
        duplicate: false,
        operation: await getOperationByCode(db, operation.code, { includeEvents: true, includeUnits: true }),
    };
}

module.exports = {
    isSystemOperation,
    simulateSystemAdminOperation,
};