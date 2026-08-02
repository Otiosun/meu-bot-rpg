'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

class FakeDb {
    constructor(operation) {
        this.operation = clone(operation);
        this.events = [];
        this.values = Object.fromEntries(operation.units.map((unit) => [unit.targetKey, 0]));
        this.tx = null;
    }

    snapshot() {
        return {
            operation: clone(this.operation),
            events: clone(this.events),
            values: clone(this.values),
        };
    }

    async exec(sql) {
        const text = String(sql).trim();
        if (text === 'BEGIN IMMEDIATE') {
            assert.equal(this.tx, null, 'nested transaction not expected');
            this.tx = this.snapshot();
            return;
        }
        if (text === 'COMMIT') {
            assert.notEqual(this.tx, null);
            this.tx = null;
            return;
        }
        if (text === 'ROLLBACK') {
            if (this.tx) {
                this.operation = this.tx.operation;
                this.events = this.tx.events;
                this.values = this.tx.values;
                this.tx = null;
            }
            return;
        }
        throw new Error(`unexpected exec: ${text}`);
    }

    async run(sql, params = []) {
        const text = String(sql).replace(/\s+/g, ' ').trim();
        if (text.startsWith('INSERT INTO clover_admin_operation_events')) {
            this.events.push({
                type: params[1],
                fromStatus: params[2],
                toStatus: params[3],
                actorId: params[4],
                payload: params[5] ? JSON.parse(params[5]) : null,
            });
            return { changes: 1, lastID: this.events.length };
        }

        if (text.includes("SET status = ?, applied_by = ?, updated_at = ?")) {
            const [status, _actor, _time, id, expected] = params;
            if (this.operation.id !== id || this.operation.status !== expected) return { changes: 0 };
            this.operation.status = status;
            return { changes: 1 };
        }

        if (text.includes("SET status = 'applied',") && text.includes("WHERE id = ? AND status = ?")) {
            const [resultJson, _appliedAt, _updatedAt, id, expected] = params;
            if (this.operation.id !== id || this.operation.status !== expected) return { changes: 0 };
            this.operation.status = 'applied';
            this.operation.result = JSON.parse(resultJson);
            this.operation.error = null;
            return { changes: 1 };
        }

        if (text.includes("SET status = 'failed', result_json = ?, error_json = ?, updated_at = ?")) {
            const [resultJson, errorJson, _time, id, expected] = params;
            if (this.operation.id !== id || this.operation.status !== expected) return { changes: 0 };
            this.operation.status = 'failed';
            this.operation.result = JSON.parse(resultJson);
            this.operation.error = JSON.parse(errorJson);
            return { changes: 1 };
        }

        if (text.includes("SET status = 'failed', error_json = ?, applied_at = NULL")) {
            const [errorJson, unitId] = params;
            const unit = this.operation.units.find((entry) => entry.id === unitId);
            if (!unit) return { changes: 0 };
            unit.status = 'failed';
            unit.error = JSON.parse(errorJson);
            unit.appliedAt = null;
            return { changes: 1 };
        }

        if (text.includes("SET status = 'applied',") && text.includes("WHERE id = ? AND status IN ('planned', 'failed')")) {
            const [summary, beforeJson, afterJson, metadataJson, appliedAt, unitId] = params;
            const unit = this.operation.units.find((entry) => entry.id === unitId);
            if (!unit || !['planned', 'failed'].includes(unit.status)) return { changes: 0 };
            unit.status = 'applied';
            unit.summary = summary;
            unit.before = JSON.parse(beforeJson);
            unit.after = JSON.parse(afterJson);
            unit.metadata = JSON.parse(metadataJson);
            unit.appliedAt = appliedAt;
            unit.error = null;
            return { changes: 1 };
        }

        if (text.includes("SET status = 'compensating', updated_at = ?")) {
            const [_time, id] = params;
            if (this.operation.id !== id || this.operation.status !== 'applied') return { changes: 0 };
            this.operation.status = 'compensating';
            return { changes: 1 };
        }

        if (text.includes("SET status = 'compensated', result_json = ?")) {
            const [resultJson, _actor, _undoneAt, _updatedAt, id] = params;
            if (this.operation.id !== id || this.operation.status !== 'compensating') return { changes: 0 };
            this.operation.status = 'compensated';
            this.operation.result = JSON.parse(resultJson);
            this.operation.error = null;
            return { changes: 1 };
        }

        if (text.includes("SET status = 'compensated', error_json = NULL, undone_at = ?")) {
            const [_time, unitId] = params;
            const unit = this.operation.units.find((entry) => entry.id === unitId);
            if (!unit || unit.status !== 'applied') return { changes: 0 };
            unit.status = 'compensated';
            unit.error = null;
            return { changes: 1 };
        }

        if (text.includes("SET status = 'applied', error_json = ?, updated_at = ?")) {
            const [errorJson, _time, id] = params;
            if (this.operation.id !== id || this.operation.status !== 'applied') return { changes: 0 };
            this.operation.error = JSON.parse(errorJson);
            return { changes: 1 };
        }

        throw new Error(`unexpected run: ${text}`);
    }
}

function operation({ status = 'approved', policy = 'atomic' } = {}) {
    return {
        id: 1,
        code: 'OP-A1B2C3',
        status,
        title: 'Operação atômica',
        reason: 'Teste',
        actor: { id: 'owner@lid', role: 'owner' },
        metadata: { executionPolicy: policy, executionPolicyDeclared: true },
        actions: [{ type: 'test.adjust', payload: {} }],
        units: [
            {
                id: 11, actionIndex: 0, targetIndex: 0, actionType: 'test.adjust',
                targetKey: 'alpha', status: status === 'failed' ? 'failed' : 'planned',
                summary: 'alpha', before: { value: 0 }, after: { value: 1 },
                metadata: { target: { kind: 'test', key: 'alpha' } }, error: null,
            },
            {
                id: 12, actionIndex: 0, targetIndex: 1, actionType: 'test.adjust',
                targetKey: 'beta', status: status === 'failed' ? 'failed' : 'planned',
                summary: 'beta', before: { value: 0 }, after: { value: 1 },
                metadata: { target: { kind: 'test', key: 'beta' } }, error: null,
            },
        ],
        events: [],
    };
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === './adminOperationServiceBase') {
        return {
            AdminOperationServiceError: class AdminOperationServiceError extends Error {
                constructor(code, message, status = 400, details = null) {
                    super(message || code);
                    this.code = code;
                    this.status = status;
                    this.details = details;
                }
            },
            async getOperationByCode(db) {
                return clone({ ...db.operation, events: db.events });
            },
        };
    }
    if (request === './adminOperationRegistryBase') {
        return {
            getAdminOperationExecutors() {
                return {
                    'catalog.trait.create': { apply() {} },
                    'catalog.trait.update': { apply() {}, undo() {} },
                    'player.item.grant': { apply() {}, undo() {} },
                };
            },
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const policy = require('../helpers/clover/adminOperationPolicy');
const atomic = require('../helpers/clover/adminOperationAtomicService');
const registry = require('../helpers/clover/adminOperationRegistry');
Module._load = originalLoad;

function executors(options = {}) {
    const calls = [];
    return {
        calls,
        registry: {
            'test.adjust': {
                atomicSafe: options.atomicSafe !== false,
                async apply({ db, target, after }) {
                    calls.push(`apply:${target.key}`);
                    if (options.failApply === target.key) {
                        const error = new Error(`falha ${target.key}`);
                        error.code = 'intentional_apply_failure';
                        throw error;
                    }
                    db.values[target.key] += 1;
                    return { after, summary: `aplicado ${target.key}` };
                },
                async undo({ db, target }) {
                    calls.push(`undo:${target.key}`);
                    if (options.failUndo === target.key) {
                        const error = new Error(`falha undo ${target.key}`);
                        error.code = 'intentional_undo_failure';
                        throw error;
                    }
                    db.values[target.key] -= 1;
                },
            },
        },
    };
}

test('política é explícita, validada e preserva per_target por compatibilidade', () => {
    assert.deepEqual(policy.requestedExecutionPolicy({}), { policy: 'per_target', declared: false });
    assert.deepEqual(policy.requestedExecutionPolicy({ executionPolicy: 'atomic' }), { policy: 'atomic', declared: true });
    assert.throws(
        () => policy.normalizeExecutionPolicy('best_effort'),
        (error) => error.code === 'invalid_execution_policy'
    );
    const decorated = policy.withExecutionPolicy({ metadata: { source: 'site' }, executionPolicy: 'atomic' });
    assert.equal(decorated.metadata.executionPolicy, 'atomic');
    assert.equal(decorated.metadata.executionPolicyDeclared, true);
    assert.equal(decorated.metadata.source, 'site');
});

test('atomic exige executor auditado', async () => {
    const db = new FakeDb(operation());
    const unsafe = executors({ atomicSafe: false });
    await assert.rejects(
        () => atomic.applyAtomicAdminOperation(db, 'OP-A1B2C3', { id: 'admin@lid' }, { executors: unsafe.registry }),
        (error) => error.code === 'atomic_policy_unsupported'
            && error.details.unsupported[0] === 'test.adjust'
    );
    assert.equal(db.operation.status, 'approved');
    assert.deepEqual(db.values, { alpha: 0, beta: 0 });
});

test('falha na segunda unidade reverte negócio, unidades e eventos intermediários', async () => {
    const db = new FakeDb(operation());
    const configured = executors({ failApply: 'beta' });
    const result = await atomic.applyAtomicAdminOperation(
        db, 'OP-A1B2C3', { id: 'admin@lid' }, { executors: configured.registry }
    );

    assert.equal(result.ok, false);
    assert.deepEqual(db.values, { alpha: 0, beta: 0 });
    assert.equal(db.operation.status, 'failed');
    assert.deepEqual(db.operation.units.map((unit) => unit.status), ['failed', 'failed']);
    assert.deepEqual(db.events.map((event) => event.type), ['atomic_failed']);
    assert.equal(db.operation.result.rolledBack, true);
    assert.equal(db.operation.result.failure.unitId, 12);
});

test('retry atômico executa todas as unidades novamente e conclui uma única vez', async () => {
    const db = new FakeDb(operation({ status: 'failed' }));
    const configured = executors();
    const result = await atomic.retryAtomicAdminOperation(
        db, 'OP-A1B2C3', { id: 'admin@lid' }, { executors: configured.registry }
    );

    assert.equal(result.ok, true);
    assert.equal(db.operation.status, 'applied');
    assert.deepEqual(db.values, { alpha: 1, beta: 1 });
    assert.deepEqual(configured.calls, ['apply:alpha', 'apply:beta']);
    assert.deepEqual(db.operation.units.map((unit) => unit.status), ['applied', 'applied']);

    const duplicate = await atomic.retryAtomicAdminOperation(
        db, 'OP-A1B2C3', { id: 'admin@lid' }, { executors: configured.registry }
    );
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(db.values, { alpha: 1, beta: 1 });
});

test('aplicação atômica bem-sucedida confirma tudo no mesmo resultado', async () => {
    const db = new FakeDb(operation());
    const configured = executors();
    const result = await atomic.applyAtomicAdminOperation(
        db, 'OP-A1B2C3', { id: 'admin@lid' }, { executors: configured.registry }
    );
    assert.equal(result.ok, true);
    assert.equal(db.operation.status, 'applied');
    assert.equal(db.operation.result.executionPolicy, 'atomic');
    assert.equal(db.operation.result.appliedCount, 2);
    assert.deepEqual(db.values, { alpha: 1, beta: 1 });
    assert.deepEqual(db.events.map((event) => event.type), [
        'applying', 'unit_applied_atomic', 'unit_applied_atomic', 'applied',
    ]);
});

test('compensação atômica usa ordem inversa e rollback integral em falha', async () => {
    const source = operation({ status: 'approved' });
    source.status = 'applied';
    source.units.forEach((unit) => { unit.status = 'applied'; });
    const db = new FakeDb(source);
    db.values = { alpha: 1, beta: 1 };
    const failing = executors({ failUndo: 'alpha' });
    const failed = await atomic.compensateAtomicAdminOperation(
        db, 'OP-A1B2C3', { id: 'admin@lid' }, { executors: failing.registry }
    );
    assert.equal(failed.ok, false);
    assert.equal(db.operation.status, 'applied');
    assert.deepEqual(db.values, { alpha: 1, beta: 1 });
    assert.deepEqual(db.operation.units.map((unit) => unit.status), ['applied', 'applied']);
    assert.deepEqual(failing.calls, ['undo:beta', 'undo:alpha']);
    assert.equal(db.events.at(-1).type, 'atomic_compensation_failed');

    const succeeding = executors();
    const compensated = await atomic.compensateAtomicAdminOperation(
        db, 'OP-A1B2C3', { id: 'admin@lid' }, { executors: succeeding.registry }
    );
    assert.equal(compensated.ok, true);
    assert.equal(db.operation.status, 'compensated');
    assert.deepEqual(db.values, { alpha: 0, beta: 0 });
    assert.deepEqual(succeeding.calls, ['undo:beta', 'undo:alpha']);
});

test('registro marca somente executores auditados e mantém trait.create bloqueado', () => {
    const marked = registry.getAdminOperationExecutors();
    assert.equal(marked['catalog.trait.update'].atomicSafe, true);
    assert.equal(marked['player.item.grant'].atomicSafe, true);
    assert.equal(marked['catalog.trait.create'].atomicSafe, false);
    assert.equal(registry.ATOMIC_SAFE_ACTION_TYPES.has('raid.progress.adjust'), true);
});
