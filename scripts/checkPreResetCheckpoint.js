'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const env = { ...process.env, NODE_ENV: 'test' };
delete env.PRE_RESET_LAUNCH_ENABLED;
delete env.PRE_RESET_FRONTEND_INTEGRATED;

function fail(label, detail) {
    console.error('PRE_RESET_CHECKPOINT_GATE=FAIL');
    console.error(`FAILED_STAGE=${label}`);
    if (detail) console.error(`DETAIL=${detail}`);
    process.exit(1);
}

function runInherited(label, args) {
    console.log(`\n=== ${label} ===`);
    const result = spawnSync(process.execPath, args, {
        cwd: root,
        env,
        stdio: 'inherit',
    });
    if (result.error) fail(label, result.error.message);
    if (result.status !== 0) fail(label, `exit_${result.status}`);
}

runInherited('PRE_RESET_PREPARATION', ['scripts/checkPreResetPreparationGate.js']);
runInherited('F7_PUBLIC_CONTRACT', ['scripts/checkF7ContractGate.js']);

console.log('\n=== PRE_RESET_LAUNCH_REPORT ===');
const launch = spawnSync(process.execPath, ['scripts/checkPreResetLaunchGate.js', '--report-only'], {
    cwd: root,
    env,
    encoding: 'utf8',
});
if (launch.stdout) process.stdout.write(launch.stdout);
if (launch.stderr) process.stderr.write(launch.stderr);
if (launch.error) fail('PRE_RESET_LAUNCH_REPORT', launch.error.message);
if (launch.status !== 0) fail('PRE_RESET_LAUNCH_REPORT', `exit_${launch.status}`);

const output = `${launch.stdout || ''}\n${launch.stderr || ''}`;
if (!output.includes('PRE_RESET_LAUNCH_GATE=NOT_READY')) {
    fail('PRE_RESET_LAUNCH_REPORT', 'expected_NOT_READY_missing');
}
if (!output.includes('PRE_RESET_LAUNCH_READY=NO')) {
    fail('PRE_RESET_LAUNCH_REPORT', 'expected_launch_ready_NO_missing');
}
if (!output.includes('ACTIVATION_AUTHORIZED=NO')) {
    fail('PRE_RESET_LAUNCH_REPORT', 'activation_authorization_guard_missing');
}

console.log('\nPRE_RESET_CHECKPOINT_GATE=PASS');
console.log('PRE_RESET_PREPARATION_GATE=PASS');
console.log('F7_CONTRACT_GATE=PASS');
console.log('PRE_RESET_LAUNCH_GATE=NOT_READY');
console.log('PRE_RESET_LAUNCH_READY=NO');
console.log('ACTIVATION_AUTHORIZED=NO');
