'use strict';

const {
    SUPPORT_MATRIX,
    summarizePreResetProductDecisions,
    validatePreResetProductDecisionManifest,
} = require('./preResetProductDecisionService');

function evaluatePreResetLaunchReadiness(manifest, options = {}) {
    const validated = validatePreResetProductDecisionManifest(manifest);
    const summary = summarizePreResetProductDecisions(validated);
    const supportMatrix = options.supportMatrix || SUPPORT_MATRIX;
    const frontendIntegrated = options.frontendIntegrated === true;
    const activationAuthorized = options.activationAuthorized === true;
    const requireProductDecisions = options.requireProductDecisions === true;
    const blockers = [];

    // Since the 2026-08-27 transition checklist, PH conversion, PR economy/shop,
    // reset-cycle and refund/session product decisions are explicitly outside
    // the PRE_RESET opening scope. Keep them visible in readiness telemetry, but
    // only make them launch blockers when a caller is evaluating the later
    // economy/reset-product gate explicitly.
    if (requireProductDecisions && summary.unresolved.length) {
        blockers.push(`UNRESOLVED_DECISIONS=${summary.unresolved.join(',')}`);
    }
    if (requireProductDecisions && validated.testOnly) blockers.push('TEST_ONLY_MANIFEST=YES');

    const supportGaps = requireProductDecisions && summary.productDecisionsResolved
        ? Object.entries(supportMatrix)
            .filter(([, item]) => item?.status === 'REQUIRES_FUTURE_IMPLEMENTATION')
            .map(([id]) => id)
        : [];
    if (supportGaps.length) blockers.push(`UNVERIFIED_IMPLEMENTATION_SUPPORT=${supportGaps.join(',')}`);
    if (!frontendIntegrated) blockers.push('FRONTEND_EXTERNAL=YES');
    if (!activationAuthorized) blockers.push('ACTIVATION_AUTHORIZED=NO');

    return Object.freeze({
        ready: blockers.length === 0,
        productDecisionsResolved: summary.productDecisionsResolved,
        unresolved: summary.unresolved,
        requireProductDecisions,
        frontendIntegrated,
        activationAuthorized,
        supportGaps: Object.freeze(supportGaps),
        testOnlyManifest: validated.testOnly,
        blockers: Object.freeze(blockers),
    });
}

module.exports = { evaluatePreResetLaunchReadiness };
