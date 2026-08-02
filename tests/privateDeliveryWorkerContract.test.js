'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    buildQueuePolicyInput,
    canonicalQueueSource,
    evaluateQueuedPrivateJob,
    isQueuedJobExpired,
    processNextPrivateDelivery,
    workerEnabled,
} = require('../helpers/clover/privateDeliveryWorker');

function makeJob(overrides = {}) {
    return {
        id: 7,
        kind: 'private_text',
        target_jid: '5511999999999@s.whatsapp.net',
        payload_json: JSON.stringify({
            text: 'Mensagem',
            source: 'post_ficha',
            metadata: {},
        }),
        category: 'critical',
        dedupe_key: 'private_text|player|post_ficha',
        status: 'pending',
        attempts: 0,
        max_attempts: 2,
        created_at: '2026-08-02 00:00:00',
        ...overrides,
    };
}

function makeDb(job = null) {
    const calls = [];
    let currentJob = job ? { ...job } : null;
    return {
        calls,
        get currentJob() {
            return currentJob;
        },
        async exec(sql) {
            calls.push({ method: 'exec', sql });
        },
        async get(sql, params) {
            calls.push({ method: 'get', sql, params });
            return currentJob?.status === 'pending' ? { ...currentJob } : null;
        },
        async run(sql, params) {
            calls.push({ method: 'run', sql, params });
            if (/SET status = 'processing'/.test(sql)) {
                currentJob = {
                    ...currentJob,
                    status: 'processing',
                    attempts: Number(currentJob.attempts || 0) + 1,
                    locked_by: params[0],
                };
            } else if (/SET status = 'pending'/.test(sql)) {
                currentJob = {
                    ...currentJob,
                    status: 'pending',
                    last_error: params[1],
                    locked_by: null,
                };
            } else if (/SET status = \?/.test(sql)) {
                currentJob = {
                    ...currentJob,
                    status: params[0],
                    last_error: params[2],
                    result_json: params[3],
                    locked_by: null,
                };
            }
            return { changes: 1 };
        },
    };
}

test('worker nasce desligado por padrão', () => {
    assert.equal(workerEnabled({}), false);
    assert.equal(workerEnabled({ CLOVER_PV_DELIVERY_WORKER_ENABLED: '1' }), true);
});

test('aliases legados preservam somente fontes conhecidas', () => {
    assert.equal(canonicalQueueSource('appearance_approved'), 'appearance_result');
    assert.equal(canonicalQueueSource('return_bonus'), 'anti_ghost_return_bonus');
    assert.equal(canonicalQueueSource('qualquer_coisa'), 'qualquer_coisa');
});

test('job transacional leva source e dedupe da fila ao transporte', () => {
    const input = buildQueuePolicyInput(makeJob());
    assert.deepEqual(input, {
        source: 'post_ficha',
        targetCount: 1,
        explicitConfirmation: false,
        dedupeKey: 'private_text|player|post_ficha',
    });
    assert.equal(evaluateQueuedPrivateJob(makeJob(), {}).allowed, true);
});

test('proativo antigo é bloqueado antes de qualquer envio', async () => {
    const job = makeJob({
        payload_json: JSON.stringify({ text: 'Volte', source: 'return_bonus' }),
        category: 'ghost',
        dedupe_key: 'return_bonus|player|2026-08-02',
    });
    const db = makeDb(job);
    let sent = 0;

    const result = await processNextPrivateDelivery({
        db,
        sock: {},
        env: { CLOVER_PV_DELIVERY_WORKER_ENABLED: '1' },
        now: new Date('2026-08-02T00:05:00Z'),
        sendPrivateText: async () => {
            sent += 1;
        },
        workerId: 'test-worker',
    });

    assert.equal(sent, 0);
    assert.equal(result.reason, 'policy_blocked');
    assert.equal(db.currentJob.status, 'cancelled');
});

test('job transacional vencido é cancelado sem transporte', async () => {
    const job = makeJob({ created_at: '2026-07-20 00:00:00' });
    assert.equal(
        isQueuedJobExpired(
            job,
            { CLOVER_PV_DELIVERY_MAX_AGE_HOURS: '72' },
            new Date('2026-08-02T00:05:00Z')
        ),
        true
    );

    const db = makeDb(job);
    let sent = 0;
    const result = await processNextPrivateDelivery({
        db,
        sock: {},
        env: {
            CLOVER_PV_DELIVERY_WORKER_ENABLED: '1',
            CLOVER_PV_DELIVERY_MAX_AGE_HOURS: '72',
        },
        now: new Date('2026-08-02T00:05:00Z'),
        sendPrivateText: async () => {
            sent += 1;
        },
        workerId: 'test-worker',
    });

    assert.equal(sent, 0);
    assert.equal(result.reason, 'job_expired');
    assert.equal(db.currentJob.status, 'cancelled');
});

test('job crítico é enviado com metadados de política e marcado sent', async () => {
    const db = makeDb(makeJob());
    const sends = [];

    const result = await processNextPrivateDelivery({
        db,
        sock: {},
        env: { CLOVER_PV_DELIVERY_WORKER_ENABLED: '1' },
        now: new Date('2026-08-02T00:05:00Z'),
        sendPrivateText: async (payload) => {
            sends.push(payload);
            return { key: { id: 'message-1' } };
        },
        workerId: 'test-worker',
    });

    assert.equal(result.sent, true);
    assert.equal(db.currentJob.status, 'sent');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].policy.source, 'post_ficha');
    assert.equal(sends[0].policy.dedupeKey, 'private_text|player|post_ficha');
});

test('falha transitória retorna job à fila até atingir maxAttempts', async () => {
    const db = makeDb(makeJob());

    const result = await processNextPrivateDelivery({
        db,
        sock: {},
        env: { CLOVER_PV_DELIVERY_WORKER_ENABLED: '1' },
        now: new Date('2026-08-02T00:05:00Z'),
        sendPrivateText: async () => {
            throw new Error('network_down');
        },
        workerId: 'test-worker',
        retryDelaySeconds: 30,
    });

    assert.equal(result.status, 'pending');
    assert.equal(db.currentJob.status, 'pending');
    assert.equal(db.currentJob.last_error, 'network_down');
});

test('última tentativa termina como failed', async () => {
    const db = makeDb(makeJob({ attempts: 1, max_attempts: 2 }));

    const result = await processNextPrivateDelivery({
        db,
        sock: {},
        env: { CLOVER_PV_DELIVERY_WORKER_ENABLED: '1' },
        now: new Date('2026-08-02T00:05:00Z'),
        sendPrivateText: async () => {
            throw new Error('permanent_failure');
        },
        workerId: 'test-worker',
    });

    assert.equal(result.status, 'failed');
    assert.equal(db.currentJob.status, 'failed');
    assert.equal(db.currentJob.last_error, 'permanent_failure');
});

test('fila vazia não chama transporte', async () => {
    const db = makeDb(null);
    let sent = false;
    const result = await processNextPrivateDelivery({
        db,
        sock: {},
        env: { CLOVER_PV_DELIVERY_WORKER_ENABLED: '1' },
        sendPrivateText: async () => {
            sent = true;
        },
    });
    assert.equal(result.reason, 'empty_queue');
    assert.equal(sent, false);
});
