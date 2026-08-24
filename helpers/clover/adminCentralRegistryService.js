'use strict';

const { ACTION_TYPES, ACTION_CAPABILITIES } = require('./adminOperationContract');

// Metadata is not authorization. Capability is derived, never copied, from
// adminOperationContract; integrated RBAC and handlers retain all authority.
const OPERATION_METADATA = Object.freeze({
    catalog: Object.freeze({ domain: 'catalog', risk: 'high' }),
    player: Object.freeze({ domain: 'player', risk: 'high' }),
    reward: Object.freeze({ domain: 'rewards', risk: 'critical' }),
    raid: Object.freeze({ domain: 'raid', risk: 'critical' }),
});

function metadataFor(operationKey) {
    const prefix = String(operationKey).split('.')[0];
    const metadata = OPERATION_METADATA[prefix];
    if (!metadata) throw new Error(`Admin operation lacks central metadata classification: ${operationKey}`);
    return {
        displayName: operationKey.replaceAll('.', ' / '),
        ...metadata,
        confirmation: true,
        audit: true,
    };
}

function getAdminCentralRegistry(executors) {
    const resolvedExecutors = executors || require('./adminOperationRegistry').getAdminOperationExecutors();
    return Object.freeze(Object.keys(resolvedExecutors).sort().map((operationKey) => {
        const capability = ACTION_CAPABILITIES[operationKey];
        if (!capability) throw new Error(`Admin executor lacks canonical capability: ${operationKey}`);
        return Object.freeze({ operationKey, ...metadataFor(operationKey), capability, input: 'handler-defined', enabled: true, handlerReference: operationKey });
    }));
}

function auditAdminCentralCoverage(executors) {
    const resolvedExecutors = executors || require('./adminOperationRegistry').getAdminOperationExecutors();
    const executorKeys = Object.keys(resolvedExecutors).sort();
    const registryKeys = getAdminCentralRegistry(resolvedExecutors).map((entry) => entry.operationKey);
    const actionKeys = [...ACTION_TYPES].sort();
    return Object.freeze({
        actionTypes: actionKeys,
        executorKeys,
        registryKeys,
        contractOnly: actionKeys.filter((key) => !executorKeys.includes(key)),
        missingRegistry: executorKeys.filter((key) => !registryKeys.includes(key)),
        staleRegistry: registryKeys.filter((key) => !executorKeys.includes(key)),
    });
}

module.exports = { OPERATION_METADATA, auditAdminCentralCoverage, getAdminCentralRegistry, metadataFor };
