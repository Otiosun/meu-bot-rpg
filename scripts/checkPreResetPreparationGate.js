'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const {
    SUPPORT_MATRIX,
    compileTestOnlyPreResetPolicyRegistry,
    loadPreResetProductDecisionManifest,
    summarizePreResetProductDecisions,
} = require('../helpers/clover/preResetProductDecisionService');
const { DEFAULT_PRE_RESET_POLICY_REGISTRY } = require('../helpers/clover/preResetPolicyRegistryService');
const { isPreResetLaunchEnabled } = require('../helpers/clover/preResetAccessService');

const root = path.resolve(__dirname, '..');
const syntheticPath = path.join(root, 'tests', 'fixtures', 'preResetProductDecisions.synthetic.json');

function fail(message) {
    console.error('PRE_RESET_PREPARATION_GATE=FAIL');
    console.error(`BLOCKER=${message}`);
    process.exit(1);
}

const manifest = loadPreResetProductDecisionManifest();
const summary = summarizePreResetProductDecisions(manifest);
if (summary.decisionTotal !== 9 || summary.decisionUnresolved !== 9 || summary.decisionApproved !== 0) {
    fail('canonical_decisions_not_exactly_9_unresolved');
}
if (summary.activationAuthorized !== false) fail('activation_must_remain_unauthorized');

for (const value of [undefined, '1', 'TRUE', 'yes', 'on', ' true ']) {
    if (isPreResetLaunchEnabled(value === undefined ? {} : { PRE_RESET_LAUNCH_ENABLED: value })) {
        fail(`unsafe_launch_flag_value:${String(value)}`);
    }
}

const defaultPolicies = DEFAULT_PRE_RESET_POLICY_REGISTRY.snapshot();
if (Object.values(defaultPolicies).some((policy) => policy.enabled || policy.status !== 'NOT_CONFIGURED')) {
    fail('default_policy_registry_not_fail_closed');
}

const synthetic = loadPreResetProductDecisionManifest(syntheticPath, { requireAllApproved: true });
const compiled = compileTestOnlyPreResetPolicyRegistry(synthetic);
if (!compiled.registry.testOnly || compiled.registry.get('PRE_RESET_MODE').enabled !== true) {
    fail('synthetic_policy_compiler_failed');
}
if (compiled.behaviorallyComplete !== false) {
    fail('support_matrix_false_green');
}

const tests = [
    'tests/preResetAccessService.test.js',
    'tests/preResetProductDecisionService.test.js',
    'tests/preResetSiteApiE2E.test.js',
];
const run = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
if (run.error || run.status !== 0) fail(`focused_tests_failed:${run.status ?? 'spawn'}`);

const supportCounts = Object.values(SUPPORT_MATRIX).reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
}, {});

console.log('DECISION_TOTAL=9');
console.log('DECISION_UNRESOLVED=9');
console.log('DECISION_APPROVED=0');
console.log('CONFIGURATION_SCHEMA_READY=YES');
console.log('PRODUCT_DECISIONS_RESOLVED=NO');
console.log(`SUPPORTED_NOW=${supportCounts.SUPPORTED_NOW || 0}`);
console.log(`PARTIALLY_SUPPORTED=${supportCounts.PARTIALLY_SUPPORTED || 0}`);
console.log(`REQUIRES_FUTURE_IMPLEMENTATION=${supportCounts.REQUIRES_FUTURE_IMPLEMENTATION || 0}`);
console.log('PRE_RESET_SURFACE_LOCKED=PASS');
console.log('PRE_RESET_MODE_DEFAULT_OFF=YES');
console.log('SYNTHETIC_POLICY_COMPILER=PASS');
console.log('SYNTHETIC_BEHAVIORALLY_COMPLETE=NO');
console.log('PRE_RESET_SYSTEM_PREPARED=PASS');
console.log('PRODUCT_DECISIONS_RESOLVED=NO');
console.log('ACTIVATION_AUTHORIZED=NO');
console.log('PRE_RESET_LAUNCH_READY=NO');
console.log('FRONTEND_EXTERNAL=YES');
console.log('PRE_RESET_PREPARATION_GATE=PASS');
