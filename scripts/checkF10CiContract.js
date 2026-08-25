'use strict';

const { auditCanonicalF10Workflow, loadF10CiContract, summarizeF10CiContract } = require('../helpers/ci/f10CiContract');

function fail(message) {
    console.error('F10_CI_CONTRACT_GATE=FAIL');
    console.error(`BLOCKER=${message}`);
    process.exit(1);
}

const contract = loadF10CiContract();
const workflow = auditCanonicalF10Workflow();
if (!workflow.pass) fail(`workflow_drift:${workflow.failures.join(',')}`);

const summary = summarizeF10CiContract(contract);
console.log(`F10_CATEGORY_TOTAL=${summary.categoryTotal}`);
for (const status of ['COVERED', 'PARTIAL', 'GAP', 'EXTERNAL', 'DEFERRED_F11']) console.log(`F10_${status}=${summary.counts[status] || 0}`);
console.log(`F10_REMOTE_SIGNAL=${summary.remoteSignal}`);
console.log(`F10_PHASE_READY=${summary.ready ? 'YES' : 'NO'}`);
console.log(`F10_BLOCKERS=${summary.blockers.join(',') || 'NONE'}`);
console.log('F10_CI_CONTRACT_GATE=PASS');
