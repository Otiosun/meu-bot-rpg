'use strict';

const base = require('./adminOperationRecoveryServiceBase');
const { getOperationByCode } = require('./adminOperationServiceBase');
const {
    compensateAtomicAdminOperation,
    retryAtomicAdminOperation,
} = require('./adminOperationAtomicService');
const { operationExecutionPolicy } = require('./adminOperationPolicy');

async function retryAdminOperation(db, code, actor, options = {}) {
    const operation = await getOperationByCode(db, code, { includeUnits: true });
    if (operationExecutionPolicy(operation) === 'atomic') {
        return retryAtomicAdminOperation(db, code, actor, options);
    }
    return base.retryAdminOperation(db, code, actor, options);
}

async function compensateAdminOperation(db, code, actor, options = {}) {
    const operation = await getOperationByCode(db, code, { includeUnits: true });
    if (operationExecutionPolicy(operation) === 'atomic') {
        return compensateAtomicAdminOperation(db, code, actor, options);
    }
    return base.compensateAdminOperation(db, code, actor, options);
}

module.exports = {
    ...base,
    compensateAdminOperation,
    retryAdminOperation,
};
