'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    EconomyQueueTimeoutError,
    getEconomyQueueState,
    isEconomyReadOperation,
    runEconomyMutationExclusive,
} = require('../helpers/clover/economyMutationQueue');

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function nextTurn() {
    return new Promise((resolve) => setImmediate(resolve));
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

    await nextTurn();
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

    await nextTurn();
    assert.deepEqual(order, ['first:start']);

    firstGate.resolve();
    await Promise.all([first, third]);

    assert.deepEqual(order, ['first:start', 'first:end', 'third:ran']);
    assert.equal(getEconomyQueueState().depth, 0);
});

test('fila reentrante reutiliza o bloqueio atual sem criar deadlock', async () => {
    const order = [];

    const result = await Promise.race([
        runEconomyMutationExclusive(async () => {
            order.push('outer:start');
            const nested = await runEconomyMutationExclusive(async () => {
                order.push('inner');
                return 42;
            }, { operation: 'inner', logger: null });
            order.push('outer:end');
            return nested;
        }, { operation: 'outer', logger: null }),
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error('deadlock na fila economica')), 250);
        }),
    ]);

    assert.equal(result, 42);
    assert.deepEqual(order, ['outer:start', 'inner', 'outer:end']);
    assert.deepEqual(getEconomyQueueState(), {
        depth: 0,
        active: false,
        operation: null,
        activeForMs: 0,
    });
});

test('classifica apenas leituras conhecidas como compartilhadas', () => {
    assert.equal(isEconomyReadOperation('GET /economy'), true);
    assert.equal(isEconomyReadOperation('GET /boxes'), true);
    assert.equal(isEconomyReadOperation('site:pr-shop-dashboard'), true);
    assert.equal(isEconomyReadOperation('POST /economy/purchases/preview'), false);
    assert.equal(isEconomyReadOperation('site:pr-shop-purchase:ph'), false);
});

test('leituras do site executam em paralelo', async () => {
    const gate = deferred();
    const started = [];
    let simultaneous = 0;
    let peak = 0;

    const first = runEconomyMutationExclusive(async () => {
        simultaneous += 1;
        peak = Math.max(peak, simultaneous);
        started.push('economy');
        await gate.promise;
        simultaneous -= 1;
    }, { operation: 'GET /economy', logger: null });

    const second = runEconomyMutationExclusive(async () => {
        simultaneous += 1;
        peak = Math.max(peak, simultaneous);
        started.push('boxes');
        await gate.promise;
        simultaneous -= 1;
    }, { operation: 'GET /boxes', logger: null });

    await nextTurn();
    assert.deepEqual(started.sort(), ['boxes', 'economy']);
    assert.equal(peak, 2);
    assert.equal(getEconomyQueueState().depth, 2);

    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(getEconomyQueueState().depth, 0);
});

test('mutacao espera leituras ativas terminarem', async () => {
    const readGate = deferred();
    const order = [];

    const read = runEconomyMutationExclusive(async () => {
        order.push('read:start');
        await readGate.promise;
        order.push('read:end');
    }, { operation: 'GET /economy', logger: null });

    const write = runEconomyMutationExclusive(async () => {
        order.push('write');
    }, { operation: 'POST /economy/purchases/preview', logger: null });

    await nextTurn();
    assert.deepEqual(order, ['read:start']);

    readGate.resolve();
    await Promise.all([read, write]);
    assert.deepEqual(order, ['read:start', 'read:end', 'write']);
});

test('leitura nova nao ultrapassa mutacao que ja esta aguardando', async () => {
    const firstReadGate = deferred();
    const writeGate = deferred();
    const order = [];

    const firstRead = runEconomyMutationExclusive(async () => {
        order.push('read-1:start');
        await firstReadGate.promise;
        order.push('read-1:end');
    }, { operation: 'GET /economy', logger: null });

    const write = runEconomyMutationExclusive(async () => {
        order.push('write:start');
        await writeGate.promise;
        order.push('write:end');
    }, { operation: 'POST /economy/purchases/preview', logger: null });

    const secondRead = runEconomyMutationExclusive(async () => {
        order.push('read-2');
    }, { operation: 'GET /boxes', logger: null });

    await nextTurn();
    assert.deepEqual(order, ['read-1:start']);

    firstReadGate.resolve();
    await nextTurn();
    assert.deepEqual(order, ['read-1:start', 'read-1:end', 'write:start']);

    writeGate.resolve();
    await Promise.all([firstRead, write, secondRead]);
    assert.deepEqual(order, ['read-1:start', 'read-1:end', 'write:start', 'write:end', 'read-2']);
});
