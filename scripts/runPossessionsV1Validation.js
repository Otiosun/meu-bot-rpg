'use strict';

const { spawnSync } = require('node:child_process');

const commands = [
    ['node', ['scripts/checkPossessionsV1Contracts.js']],
    ['npm', ['run', 'test:possessions-v1']],
    ['npm', ['run', 'test:admin-core']],
    ['npm', ['run', 'test:event-economy']],
    ['npm', ['run', 'test:raid-finalization']],
];

for (const [command, args] of commands) {
    const executable = process.platform === 'win32' && command === 'npm'
        ? 'npm.cmd'
        : command;
    console.log(`\n=== ${executable} ${args.join(' ')} ===`);
    const result = spawnSync(executable, args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: 'inherit',
        shell: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}

console.log('\nPossessions V1 validation: OK');
