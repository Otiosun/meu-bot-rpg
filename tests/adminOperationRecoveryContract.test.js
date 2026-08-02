'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

class ServiceError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

async function getOperationByCode(db, code) {
    if (String(code).toUpperCase() !== db.operation.code) {
        throw new ServiceError('operation_not_found', 'Operação não encontrada.', 404);
    }
    return clone({ ...db.operation, units: db.units, events: db.events });
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === './adminOperationService' || request === './adminOperationServiceBase') {
        return { AdminOperationServiceError: ServiceError, getOperationByCode };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const {
    acceptPartialAdminOperation,
    compensateAdminOperation,
    retryAdminOperation,
} = require('../helpers/clover/adminOperationRecoveryService');
Module._load = originalLoad;

class FakeDb {
    constructor({ status = 'partially_applied', units = [], claimConflict = false } = {}) {
        this.operation = {
            id: 7,
            code: 'OP-ABC123',
            status,
            actions: [
                { type: 'player.trait.assign', payload: { value: 'A' } },
                { type: 'player.item.grant', payload: { value: 'B' } },
            ],
            result: null,
            error: null,
        };
        this.units = clone(units);
        this.events = [];
        this.claimConflict = claimConflict;
        this.savepoints = [];
    }

    async exec(sql) {
        this.savepoints.push(sql);
    }

    async run(sql, params = []) {
        if (sql.includes('INSERT INTO clover_admin_operation_events')) {
            const [operationId, eventType, fromStatus, toStatus, actorId, payloadJson, createdAt] = params;
            this.events.push({
                operationId,
                type: eventType,
                fromStatus,
                toStatus,
                actorId,
                payload: payloadJson ? JSON.parse(payloadJson) : null,
                createdAt,
            });
            return { changes: 1, lastID: this.events.length };
        }

        if (sql.includes('UPDATE clover_admin_operations') && sql.includes('status IN (')) {
            if (this.claimConflict) {
                this.claimConflict = false;
                return { changes: 0 };
            }
            const [toStatus, , operationId, ...allowed] = params;
            if (operationId !== this.operation.id || !allowed.includes(this.operation.status)) {
                return { changes: 0 };
            }
            this.operation.status = toStatus;
            return { changes: 1 };
        }

        if (sql.includes('UPDATE clover_admin_operations')
            && sql.includes('result_json = ?')
            && sql.includes('status = ?')) {
            const [finalStatus, resultJson, errorJson, , operationId, expectedStatus] = params;
            if (operationId !== this.operation.id || this.operation.status !== expectedStatus) {
                return { changes: 0 };
            }
            this.operation.status = finalStatus;
            this.operation.result = JSON.parse(resultJson);
            this.operation.error = errorJson ? JSON.parse(errorJson) : null;
            return { changes: 1 };
        }

        if (sql.includes("SET status = 'accepted_partial'")) {
            const [resultJson, , operationId] = params;
            if (operationId !== this.operation.id || this.operation.status !== 'partially_applied') {
                return { changes: 0 };
            }
            this.operation.status = 'accepted_partial';
            this.operation.result = JSON.parse(resultJson);
            this.operation.error = null;
            return { changes: 1 };
        }

        if (sql.includes("SET status = 'applied'")) {
            const unitId = params.at(-1);
            const unit = this.units.find((entry) => entry.id === unitId);
            if (!unit || unit.status !== 'failed') return { changes: 0 };
            unit.status = 'applied';
            unit.summary = params[0] || unit.summary;
            unit.before = JSON.parse(params[1]);
            unit.after = JSON.parse(params[2]);
            unit.metadata = JSON.parse(params[3]);
            unit.error = null;
            return { changes: 1 };
        }

        if (sql.includes("SET status = 'compensated'")) {
            const unitId = params[1];
            const unit = this.units.find((entry) => entry.id === unitId);
            if (!unit || unit.status !== 'applied') return { changes: 0 };
            unit.status = 'compensated';
            unit.error = null;
            return { changes: 1 };
        }

        if (sql.includes("SET status = 'failed'")) {
            const unitId = params.at(-1);
            const unit = this.units.find((entry) => entry.id === unitId);
            if (unit) {
                unit.status = 'failed';
                unit.error = JSON.parse(params[0]);
            }
            return { changes: unit ? 1 : 0 };
        }

        if (sql.includes('SET error_json = ? WHERE id = ?')) {
            const [errorJson, unitId] = params;
            const unit = this.units.find((entry) => entry.id === unitId);
            if (unit) unit.error = JSON.parse(errorJson);
            return { changes: unit ? 1 : 0 };
        }

        return { changes: 0 };
    }
}

function unit(id, status, actionIndex, targetIndex) {
    return {
        id,
        actionIndex,
        targetIndex,
        actionType: actionIndex === 0 ? 'player.trait.assign' : 'player.item.grant',
        targetKey: `player-${id}`,
        status,
        summary: `unit-${id}`,
        before: { value: `before-${id}` },
        after: { value: `after-${id}` },
        metadata: { target: { kind: 'player', playerId: `player-${id}` } },
        error: status === 'failed' ? { code: 'old_failure' } : null,
    };
}

test('retry executa apenas unidades falhas e conclui operação', async () => {
    const db = new FakeDb({
        units: [unit(1, 'applied', 0, 0), unit(2, 'failed', 1, 0)],
    });
    const calls = [];
    const result = await retryAdminOperation(db, 'OP-ABC123', { id: 'owner' }, {
        executors: {
            'player.trait.assign': {
                async apply() { throw new Error('não deveria repetir unidade aplicada'); },
            },
            'player.item.grant': {
                async apply(context) {
                    calls.push(context.unit.id);
                    return {
                        summary: 'reaplicada',
                        before: { value: 'old' },
                        after: { value: 'new' },
                        metadata: { target: { kind: 'player', playerId: 'player-2' } },
                    };
                },
            },
        },
    });

    assert.equal(result.operation.status, 'applied');
    assert.deepEqual(calls, [2]);
    assert.equal(db.units[0].status, 'applied');
    assert.equal(db.units[1].status, 'applied');
    assert.equal(db.events.at(-1).type, 'applied');
});

test('retry em operação já aplicada é idempotente', async () => {
    const db = new FakeDb({ status: 'applied', units: [unit(1, 'applied', 0, 0)] });
    const result = await retryAdminOperation(db, 'OP-ABC123', { id: 'owner' }, { executors: {} });
    assert.equal(result.duplicate, true);
    assert.equal(db.events.length, 0);
});

test('compensação desfaz unidades aplicadas em ordem inversa', async () => {
    const db = new FakeDb({
        status: 'applied',
        units: [unit(1, 'applied', 0, 0), unit(2, 'applied', 1, 0), unit(3, 'applied', 1, 1)],
    });
    const calls = [];
    const executors = {
        'player.trait.assign': { async undo(context) { calls.push(context.unit.id); } },
        'player.item.grant': { async undo(context) { calls.push(context.unit.id); } },
    };
    const result = await compensateAdminOperation(db, 'OP-ABC123', { id: 'owner' }, { executors });

    assert.deepEqual(calls, [3, 2, 1]);
    assert.equal(result.operation.status, 'compensated');
    assert.deepEqual(db.units.map((entry) => entry.status), ['compensated', 'compensated', 'compensated']);
});

test('falha na compensação permanece parcial e pode ser retomada', async () => {
    const db = new FakeDb({
        status: 'applied',
        units: [unit(1, 'applied', 0, 0), unit(2, 'applied', 1, 0)],
    });
    let fail = true;
    const executors = {
        'player.trait.assign': { async undo() {} },
        'player.item.grant': {
            async undo() {
                if (fail) throw new ServiceError('undo_failed', 'falha simulada', 409);
            },
        },
    };

    const first = await compensateAdminOperation(db, 'OP-ABC123', { id: 'owner' }, { executors });
    assert.equal(first.operation.status, 'partially_applied');
    assert.equal(db.units[1].status, 'applied');
    assert.equal(db.units[0].status, 'compensated');

    fail = false;
    const second = await compensateAdminOperation(db, 'OP-ABC123', { id: 'owner' }, { executors });
    assert.equal(second.operation.status, 'compensated');
    assert.equal(db.units[1].status, 'compensated');
});

test('aceite parcial exige justificativa e produz recibo final', async () => {
    const db = new FakeDb({
        units: [unit(1, 'applied', 0, 0), unit(2, 'failed', 1, 0)],
    });
    await assert.rejects(
        () => acceptPartialAdminOperation(db, 'OP-ABC123', { id: 'owner' }, '  '),
        (error) => error.code === 'partial_acceptance_reason_required'
    );

    const result = await acceptPartialAdminOperation(
        db,
        'OP-ABC123',
        { id: 'owner' },
        'Falha externa aceita após conferência manual.'
    );
    assert.equal(result.operation.status, 'accepted_partial');
    assert.equal(
        db.operation.result.justification,
        'Falha externa aceita após conferência manual.'
    );
    assert.deepEqual(db.operation.result.unitCounts, { applied: 1, failed: 1 });
    assert.equal(db.events.at(-1).type, 'accepted_partial');
});

test('claim atômico impede dois retries simultâneos', async () => {
    const db = new FakeDb({ units: [unit(1, 'failed', 0, 0)], claimConflict: true });
    await assert.rejects(
        () => retryAdminOperation(db, 'OP-ABC123', { id: 'owner' }, {
            executors: {
                'player.trait.assign': { async apply() { return {}; } },
                'player.item.grant': { async apply() { return {}; } },
            },
        }),
        (error) => error.code === 'operation_recovery_conflict'
    );
});
