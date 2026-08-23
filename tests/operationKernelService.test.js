'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { OperationKernelError, runOperationKernel } = require('../helpers/clover/operationKernelService');

test('kernel exige actor canonico antes de qualquer etapa', async () => {
    let mutated = false;
    await assert.rejects(
        runOperationKernel({ operation: 'fixture', mutate: async () => { mutated = true; } }),
        (error) => error instanceof OperationKernelError && error.code === 'unauthorized'
    );
    assert.equal(mutated, false);
});

test('kernel ordena authorize, validate, serializacao e mutation', async () => {
    const stages = [];
    const result = await runOperationKernel({
        actor: { authenticated: true, playerId: 'fixture-actor' },
        operation: 'fixture-operation',
        authorize: async () => { stages.push('authorize'); },
        validate: async () => { stages.push('validate'); },
        mutationRunner: async (action, context) => { stages.push(context.operation); return action(); },
        mutate: async () => { stages.push('mutate'); return { ok: true }; },
    });
    assert.deepEqual(stages, ['authorize', 'validate', 'fixture-operation', 'mutate']);
    assert.deepEqual(result, { ok: true });
});

test('kernel nao serializa nem muta quando authorization ou validation falha', async () => {
    let serialized = false;
    let mutated = false;
    await assert.rejects(runOperationKernel({
        actor: { authenticated: true, playerId: 'fixture-actor' }, operation: 'denied',
        authorize: async () => { throw Object.assign(new Error('denied'), { code: 'capability_denied' }); },
        mutationRunner: async () => { serialized = true; }, mutate: async () => { mutated = true; },
    }));
    assert.equal(serialized, false);
    assert.equal(mutated, false);
});
