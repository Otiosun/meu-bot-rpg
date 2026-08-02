'use strict';

const base = require('./adminOperationServiceBase');
const { applyAtomicAdminOperation } = require('./adminOperationAtomicService');
const { getAdminOperationExecutors } = require('./adminOperationRegistry');
const {
    assertAtomicExecutors,
    operationExecutionPolicy,
    requestedExecutionPolicy,
    withExecutionPolicy,
} = require('./adminOperationPolicy');

function executorsFor(options = {}) {
    return options.executors || getAdminOperationExecutors();
}

async function createAdminOperation(db, input, actor, options = {}) {
    const decorated = withExecutionPolicy(input);
    if (requestedExecutionPolicy(decorated).policy === 'atomic') {
        assertAtomicExecutors(decorated.actions, executorsFor(options));
    }
    return base.createAdminOperation(db, decorated, actor, options);
}

async function simulateAdminOperation(db, code, actor, options = {}) {
    const operation = await base.getOperationByCode(db, code);
    if (operationExecutionPolicy(operation) === 'atomic') {
        assertAtomicExecutors(operation.actions, executorsFor(options));
    }
    return base.simulateAdminOperation(db, code, actor, options);
}

async function applyAdminOperation(db, code, actor, options = {}) {
    const operation = await base.getOperationByCode(db, code, { includeUnits: true });
    if (operationExecutionPolicy(operation) === 'atomic') {
        return applyAtomicAdminOperation(db, code, actor, {
            ...options,
            executors: executorsFor(options),
        });
    }
    return base.applyAdminOperation(db, code, actor, options);
}

module.exports = {
    ...base,
    applyAdminOperation,
    createAdminOperation,
    simulateAdminOperation,
};
