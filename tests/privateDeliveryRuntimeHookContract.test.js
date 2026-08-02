'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    inspectReachoutLock,
    runOnOpenEnabled,
    runPrivateDeliveryWorkerOnce,
} = require('../helpers/clover/privateDeliveryRuntimeHook');

const ENABLED_ENV = Object.freeze({
    CLOVER_PV_DELIVERY_WORKER_ENABLED: '1',
    CLOVER_PV_DELIVERY_RUN_ON_OPEN: '1',
});

test('execução na abertura exige flag própria além do worker', () => {
    assert.equal(runOnOpenEnabled({}), false);
    assert.equal(runOnOpenEnabled({ CLOVER_PV_DELIVERY_RUN_ON_OPEN: '1' }), true);
});

test('worker desligado não consulta WhatsApp nem fila', async () => {
    let fetched = 0;
    let processed = 0;
    const result = await runPrivateDeliveryWorkerOnce({
        env: {},
        sock: {
            async fetchAccountReachoutTimelock() {
                fetched += 1;
                return null;
            },
        },
        processNextPrivateDelivery: async () => {
            processed += 1;
        },
    });
    assert.equal(result.reason, 'worker_disabled');
    assert.equal(fetched, 0);
    assert.equal(processed, 0);
});

test('flag de abertura desligada não consulta WhatsApp nem fila', async () => {
    let fetched = 0;
    let processed = 0;
    const result = await runPrivateDeliveryWorkerOnce({
        env: { CLOVER_PV_DELIVERY_WORKER_ENABLED: '1' },
        sock: {
            async fetchAccountReachoutTimelock() {
                fetched += 1;
                return null;
            },
        },
        processNextPrivateDelivery: async () => {
            processed += 1;
        },
    });
    assert.equal(result.reason, 'run_on_open_disabled');
    assert.equal(fetched, 0);
    assert.equal(processed, 0);
});

test('trava ativa impede reivindicação de job', async () => {
    let processed = 0;
    const result = await runPrivateDeliveryWorkerOnce({
        env: ENABLED_ENV,
        sock: {
            async fetchAccountReachoutTimelock() {
                return {
                    isActive: true,
                    enforcementType: 'reachout_time_lock',
                    timeEnforcementEnds: '2026-08-03T00:00:00Z',
                };
            },
        },
        processNextPrivateDelivery: async () => {
            processed += 1;
        },
    });
    assert.equal(result.reason, 'reachout_locked');
    assert.equal(processed, 0);
});

test('falha ao consultar trava falha fechado antes da fila', async () => {
    let processed = 0;
    const result = await runPrivateDeliveryWorkerOnce({
        env: ENABLED_ENV,
        sock: {
            async fetchAccountReachoutTimelock() {
                throw new Error('reachout_unavailable');
            },
        },
        processNextPrivateDelivery: async () => {
            processed += 1;
        },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'reachout_state_unavailable');
    assert.equal(processed, 0);
});

test('ausência da API de trava usa a proteção já instalada no socket', async () => {
    const reachout = await inspectReachoutLock({});
    assert.deepEqual(reachout, { ok: true, available: false, lock: null });
});

test('duas flags e ausência de trava processam exatamente um job', async () => {
    const calls = [];
    const transports = {
        sendPrivateText: async () => null,
        sendPrivateMessage: async () => null,
        sendSpellReviewInvite: async () => null,
    };
    const result = await runPrivateDeliveryWorkerOnce({
        env: ENABLED_ENV,
        db: { marker: 'db' },
        sock: {
            marker: 'sock',
            async fetchAccountReachoutTimelock() {
                return { isActive: false };
            },
        },
        context: 'connection_open',
        ...transports,
        processNextPrivateDelivery: async (options) => {
            calls.push(options);
            return { ok: true, sent: true, jobId: 91 };
        },
    });

    assert.equal(result.sent, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].db.marker, 'db');
    assert.equal(calls[0].sock.marker, 'sock');
    assert.equal(calls[0].sendPrivateText, transports.sendPrivateText);
    assert.equal(calls[0].sendPrivateMessage, transports.sendPrivateMessage);
    assert.equal(calls[0].sendSpellReviewInvite, transports.sendSpellReviewInvite);
    assert.match(calls[0].workerId, /^pv-worker:\d+:connection_open$/);
});
