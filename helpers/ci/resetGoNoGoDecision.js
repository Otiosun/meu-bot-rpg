'use strict';

function evaluateResetGoNoGoDecision({
    itemResults = [],
    productResolved = false,
    unresolved = [],
    defaultPreResetOff = false,
    currentPreResetOff = false,
    currentGlobalResetSwitchOff = false,
    executionAuthorized = false,
} = {}) {
    const blockers = [];
    for (const item of itemResults) {
        if (!item?.pass) {
            const failed = Array.isArray(item?.failedGates) ? item.failedGates.join('+') : 'unknown';
            blockers.push(`p0:${item?.id || 'unknown'}:${failed}`);
        }
    }
    if (!productResolved) blockers.push(`product_decisions_unresolved:${unresolved.join(',') || 'unknown'}`);
    if (!defaultPreResetOff) blockers.push('pre_reset_default_not_off');
    if (!currentPreResetOff) blockers.push('pre_reset_currently_enabled');
    if (!currentGlobalResetSwitchOff) blockers.push('global_reset_mutation_switch_enabled_during_gate');
    if (!executionAuthorized) blockers.push('reset_execution_not_explicitly_authorized');

    const passedP0 = itemResults.filter((item) => item?.pass === true).length;
    const go = itemResults.length > 0
        && passedP0 === itemResults.length
        && blockers.length === 0;

    return Object.freeze({
        go,
        blockers: Object.freeze(blockers),
        passedP0,
        totalP0: itemResults.length,
    });
}

module.exports = { evaluateResetGoNoGoDecision };
