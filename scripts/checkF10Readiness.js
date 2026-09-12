'use strict';

const { auditCanonicalF10Workflow, loadF10CiContract, summarizeF10CiContract } = require('../helpers/ci/f10CiContract');

const reportOnly = process.argv.includes('--report-only');
const contract = loadF10CiContract();
const workflow = auditCanonicalF10Workflow();
const summary = summarizeF10CiContract(contract);
const ready = workflow.pass && summary.ready;

console.log(`F10_READINESS_GATE=${ready ? 'PASS' : 'NOT_READY'}`);
console.log(`F10_CI_CONTRACT=${workflow.pass ? 'PASS' : 'FAIL'}`);
console.log(`F10_REMOTE_SIGNAL=${summary.remoteSignal}`);
console.log(`F10_BLOCKERS=${[...summary.blockers, ...workflow.failures.map((item) => `workflow:${item}`)].join(',') || 'NONE'}`);
console.log(`F10_READY=${ready ? 'YES' : 'NO'}`);

if (!ready && !reportOnly) process.exitCode = 2;
