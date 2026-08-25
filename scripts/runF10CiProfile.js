'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { loadF10CiContract, validateF10CiContract } = require('../helpers/ci/f10CiContract');

const profileName = String(process.argv[2] || '').trim();
const contract = validateF10CiContract(loadF10CiContract());
const profile = contract.profiles[profileName];

if (!profile) {
    console.error('F10_PROFILE_GATE=FAIL');
    console.error(`BLOCKER=unknown_profile:${profileName || '(empty)'}`);
    process.exit(2);
}

const expectedPlatform = profileName === 'windows-critical' ? 'win32' : 'linux';
if (process.platform !== expectedPlatform && !process.argv.includes('--allow-platform-mismatch')) {
    console.error('F10_PROFILE_GATE=FAIL');
    console.error(`BLOCKER=platform_mismatch:expected_${expectedPlatform}:actual_${process.platform}`);
    process.exit(2);
}

const env = { ...process.env, NODE_ENV: 'test' };
delete env.PRE_RESET_LAUNCH_ENABLED;
delete env.PRE_RESET_FRONTEND_INTEGRATED;

const results = [];
for (const gate of profile.gates) {
    const started = Date.now();
    const executable = gate.command[0] === 'npm' && process.platform === 'win32' ? 'npm.cmd' : gate.command[0];
    const args = gate.command.slice(1);
    console.log(`\n[F10] START ${profileName}/${gate.id}`);
    const run = spawnSync(executable, args, {
        cwd: path.resolve(__dirname, '..'),
        env,
        stdio: 'inherit',
        shell: false,
    });
    const durationMs = Date.now() - started;
    results.push({ id: gate.id, status: run.status, durationMs });
    if (run.error || run.status !== 0) {
        console.error('F10_PROFILE_GATE=FAIL');
        console.error(`FAILED_GATE=${gate.id}`);
        console.error(`EXIT=${run.status ?? 'spawn_error'}`);
        if (run.error) console.error(`DETAIL=${run.error.message}`);
        process.exit(1);
    }
    console.log(`[F10] PASS ${profileName}/${gate.id} ${durationMs}ms`);
}

console.log(JSON.stringify({
    profile: profileName,
    runner: profile.runner,
    gatesTotal: profile.gates.length,
    gatesPassed: results.length,
    durationMs: results.reduce((sum, item) => sum + item.durationMs, 0),
}));
console.log('F10_PROFILE_GATE=PASS');
