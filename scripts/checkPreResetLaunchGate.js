'use strict';

const {
    SUPPORT_MATRIX,
    loadPreResetProductDecisionManifest,
    summarizePreResetProductDecisions,
} = require('../helpers/clover/preResetProductDecisionService');

const reportOnly = process.argv.includes('--report-only');
const manifest = loadPreResetProductDecisionManifest();
const summary = summarizePreResetProductDecisions(manifest);
const frontendIntegrated = process.env.PRE_RESET_FRONTEND_INTEGRATED === 'true';
const blockers = [];

if (summary.unresolved.length) blockers.push(`UNRESOLVED_DECISIONS=${summary.unresolved.join(',')}`);
if (!frontendIntegrated) blockers.push('FRONTEND_EXTERNAL=YES');
if (!summary.activationAuthorized) blockers.push('ACTIVATION_AUTHORIZED=NO');

const knownSupportGaps = Object.entries(SUPPORT_MATRIX)
    .filter(([, item]) => item.status === 'REQUIRES_FUTURE_IMPLEMENTATION')
    .map(([id]) => id);

const ready = blockers.length === 0;
console.log(`PRE_RESET_LAUNCH_GATE=${ready ? 'PASS' : 'NOT_READY'}`);
console.log(`PRODUCT_DECISIONS_RESOLVED=${summary.productDecisionsResolved ? 'YES' : 'NO'}`);
console.log(`UNRESOLVED_DECISIONS=${summary.unresolved.join(',') || 'NONE'}`);
console.log(`FRONTEND_EXTERNAL=${frontendIntegrated ? 'NO' : 'YES'}`);
console.log(`ACTIVATION_AUTHORIZED=${summary.activationAuthorized ? 'YES' : 'NO'}`);
console.log(`KNOWN_SUPPORT_GAPS=${knownSupportGaps.join(',') || 'NONE'}`);
console.log(`PRE_RESET_LAUNCH_READY=${ready ? 'YES' : 'NO'}`);
console.log(`BLOCKERS=${blockers.join(';') || 'NONE'}`);

if (!ready && !reportOnly) process.exitCode = 2;
