'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    PRIVATE_KINDS,
    claimNextPrivateJob,
} = require('../helpers/clover/privateDeliveryWorker');

function makeQueueDb(rows) {
    const state = rows.map((row) => ({ ...row }));
    const calls = [];

    return {
        calls,
        rows: state,
        async exec(sql) {
            calls.push({ method: 'exec', sql });
        },
        async get(sql, params = []) {
            calls.push({ method: 'get', sql, params });
            const allowedKinds = new Set(params);
            return state
                .filter((row) => row.status === 'pending' && allowedKinds.has(row.kind))
                .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0) || left.id - right.id)[0]
                || null;
        },
        async run(sql, params = []) {
            calls.push({ method: 'run', sql, params });
            const jobId = Number(params[1]);
            const row = state.find((item) => Number(item.id) === jobId);
            if (!row || row.status !== 'pending') return { changes: 0 };
            row.status = 'processing';
            row.attempts = Number(row.attempts || 0) + 1;
            row.locked_by = params[0];
            return { changes: 1 };
        },
    };
}

test('worker reivindica PV e deixa jobs de sistema intactos', async () => {
    const systemJob = {
        id: 1,
        kind: 'approve_pending_off',
        status: 'pending',
        priority: 100,
        attempts: 0,
    };
    const privateJob = {
        id: 2,
        kind: 'private_text',
        status: 'pending',
        priority: 1,
        attempts: 0,
    };
    const db = makeQueueDb([systemJob, privateJob]);

    const result = await claimNextPrivateJob(db, { workerId: 'isolation-test' });

    assert.equal(result.ok, true);
    assert.equal(result.job.id, privateJob.id);
    assert.equal(db.rows.find((row) => row.id === systemJob.id).status, 'pending');
    assert.equal(db.rows.find((row) => row.id === privateJob.id).status, 'processing');

    const select = db.calls.find((call) => call.method === 'get');
    assert.match(select.sql, /kind IN\s*\(/);
    assert.deepEqual(select.params, PRIVATE_KINDS);
});

test('fila com apenas jobs de sistema parece vazia para o worker privado', async () => {
    const db = makeQueueDb([
        {
            id: 10,
            kind: 'approve_pending_spell_review',
            status: 'pending',
            priority: 50,
            attempts: 0,
        },
        {
            id: 11,
            kind: 'approve_pending_off',
            status: 'pending',
            priority: 50,
            attempts: 0,
        },
    ]);

    const result = await claimNextPrivateJob(db, { workerId: 'isolation-test' });

    assert.equal(result.ok, true);
    assert.equal(result.job, null);
    assert.equal(db.rows.every((row) => row.status === 'pending'), true);
    assert.equal(db.calls.some((call) => call.method === 'run'), false);
});
