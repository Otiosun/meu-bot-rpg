'use strict';

const {
    ACTION_CAPABILITIES,
    ACTION_TYPES,
} = require('./adminOperationContract');
const { getAdminOperationExecutors } = require('./adminOperationRegistry');

function buildAdminActionCoverage(options = {}) {
    const registry = options.registry || getAdminOperationExecutors();
    return ACTION_TYPES.map((type) => {
        const executor = registry[type] || null;
        const preview = typeof executor?.preview === 'function';
        const apply = typeof executor?.apply === 'function';
        const undo = typeof executor?.undo === 'function';
        return {
            type,
            capability: ACTION_CAPABILITIES[type] || null,
            available: preview && apply,
            preview,
            apply,
            undo,
            atomicSafe: executor?.atomicSafe === true,
        };
    });
}

function unavailableAdminActionTypes(options = {}) {
    return buildAdminActionCoverage(options)
        .filter((entry) => !entry.available)
        .map((entry) => entry.type);
}

function assertAdminActionCoverageComplete(options = {}) {
    const unavailable = unavailableAdminActionTypes(options);
    if (!unavailable.length) return true;
    const error = new Error(
        `A Central ADM ainda possui ações sem executor completo: ${unavailable.join(', ')}`
    );
    error.code = 'admin_action_coverage_incomplete';
    error.details = { unavailable };
    throw error;
}

module.exports = {
    assertAdminActionCoverageComplete,
    buildAdminActionCoverage,
    unavailableAdminActionTypes,
};
