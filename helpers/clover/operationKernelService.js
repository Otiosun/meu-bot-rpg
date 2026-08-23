'use strict';

const { runEconomyMutationExclusive } = require('./economyMutationQueue');

class OperationKernelError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'OperationKernelError';
        this.code = code;
    }
}

function assertCanonicalActor(actor = {}) {
    if (!actor || !String(actor.playerId || '').trim() || actor.authenticated !== true) {
        throw new OperationKernelError('unauthorized', 'Sessao invalida ou expirada.');
    }
    return actor;
}

async function runOperationKernel(options = {}) {
    const actor = assertCanonicalActor(options.actor);
    const operation = String(options.operation || '').trim();
    if (!operation || typeof options.mutate !== 'function') {
        throw new OperationKernelError('invalid_operation', 'Operacao invalida.');
    }
    // Authentication is complete at the HTTP boundary. These stages are kept
    // explicit so business services retain their own idempotency/transaction
    // semantics while every adopted route has the same access and serialization
    // boundary.
    if (typeof options.authorize === 'function') await options.authorize(actor);
    if (typeof options.validate === 'function') await options.validate(actor);
    const runner = options.mutationRunner || runEconomyMutationExclusive;
    return runner(() => options.mutate(actor), {
        operation,
        requestId: options.requestId || null,
    });
}

module.exports = {
    OperationKernelError,
    assertCanonicalActor,
    runOperationKernel,
};
