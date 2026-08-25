'use strict';

const { loadPreResetProductDecisionManifest } = require('../helpers/clover/preResetProductDecisionService');
const { evaluatePreResetLaunchReadiness } = require('../helpers/clover/preResetReadinessService');

const reportOnly = process.argv.includes('--report-only');
const manifest = loadPreResetProductDecisionManifest();
const readiness = evaluatePreResetLaunchReadiness(manifest, {
    frontendIntegrated: process.env.PRE_RESET_FRONTEND_INTEGRATED === 'true',
    activationAuthorized: false,
});

console.log(`PRE_RESET_LAUNCH_GATE=${readiness.ready ? 'PASS' : 'NOT_READY'}`);
console.log(`PRODUCT_DECISIONS_RESOLVED=${readiness.productDecisionsResolved ? 'YES' : 'NO'}`);
console.log(`UNRESOLVED_DECISIONS=${readiness.unresolved.join(',') || 'NONE'}`);
console.log(`FRONTEND_EXTERNAL=${readiness.frontendIntegrated ? 'NO' : 'YES'}`);
console.log(`ACTIVATION_AUTHORIZED=${readiness.activationAuthorized ? 'YES' : 'NO'}`);
console.log(`KNOWN_SUPPORT_GAPS=${readiness.supportGaps.join(',') || 'NONE'}`);
console.log(`TEST_ONLY_MANIFEST=${readiness.testOnlyManifest ? 'YES' : 'NO'}`);
console.log(`PRE_RESET_LAUNCH_READY=${readiness.ready ? 'YES' : 'NO'}`);
console.log(`BLOCKERS=${readiness.blockers.join(';') || 'NONE'}`);

if (!readiness.ready && !reportOnly) process.exitCode = 2;
