'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    EconomyQueueTimeoutError,
    getEconomyQueueState,
    runEconomyMutationExclusive,
} = require('../helpers/clover/economyMutationQueue');

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

test('fila executa mutacoes em ordem, sem sobreposicao', async () => {
    const firstGate = deferred();
    const order = [];
    let simultaneous = 0;
    let peak = 0;

    const first = runEconomyMutationExclusive(async () => {
        simultaneous += 1;
        peak = Math.max(peak, simultaneous);
        order.push('first:start');
        await firstGate.promise;
        order.push('first:end');
        simultaneous -= 1;
    }, { operation: 'first', logger: null });

    const second = runEconomyMutationExclusive(async () => {
        simultaneous += 1;
        peak = Math.max(peak, simultaneous);
        order.push('second:start');
        simultaneous -= 1;
    }, { operation: 'second', logger: null });

    await new Promise((resolve) => setImmediate(resolve));
    const activeState = getEconomyQueueState();
    assert.equal(activeState.depth, 2);
    assert.equal(activeState.active, true);
    assert.equal(activeState.operation, 'first');
    assert.ok(activeState.activeForMs >= 0);

    firstGate.resolve();
    await Promise.all([first, second]);

    assert.equal(peak, 1);
    assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
    assert.deepEqual(getEconomyQueueState(), {
        depth: 0,
        active: false,
        operation: null,
        activeForMs: 0,
    });
});

test('timeout de espera nao libera uma mutacao concorrente nem corrompe a fila', async () => {
    const firstGate = deferred();
    const order = [];

    const first = runEconomyMutationExclusive(async () => {
        order.push('first:start');
        await firstGate.promise;
        order.push('first:end');
    }, { operation: 'first', logger: null });

    const timedOut = runEconomyMutationExclusive(async () => {
        order.push('timed-out:ran');
    }, {
        operation: 'timed-out',
        maxWaitMs: 20,
        logger: { warn() {} },
    });

    await assert.rejects(
        timedOut,
        (error) => error instanceof EconomyQueueTimeoutError
            && error.code === 'economy_queue_timeout'
            && error.details.operation === 'timed-out'
    );

    const third = runEconomyMutationExclusive(async () => {
        order.push('third:ran');
    }, { operation: 'third', logger: null });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ['first:start']);

    firstGate.resolve();
    await Promise.all([first, third]);

    assert.deepEqual(order, ['first:start', 'first:end', 'third:ran']);
    assert.equal(getEconomyQueueState().depth, 0);
});
