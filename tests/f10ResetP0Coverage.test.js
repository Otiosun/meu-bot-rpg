'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { loadF10CiContract } = require('../helpers/ci/f10CiContract');

const REQUIRED_RESET_GATES = Object.freeze({
    'canonical-migration-bootstrap': Object.freeze([
        'node', '--test', 'tests/f10MigrationBootstrap.test.js', 'tests/globalResetJournalFreeze.test.js',
    ]),
    'reset-backup-restore': Object.freeze([
        'node', '--test', 'tests/f10BackupRestoreDrill.test.js',
    ]),
    'global-reset-orchestrator': Object.freeze([
        'node', '--test',
        'tests/globalPlayerResetService.test.js',
        'tests/globalPlayerResetRecovery.test.js',
        'tests/globalPlayerResetEventBinding.test.js',
    ]),
    'reset-recovery-smoke': Object.freeze([
        'node', '--test', 'tests/resetGoNoGoSmoke.test.js',
    ]),
});

for (const profileName of ['linux-main', 'windows-critical']) {
    test(`F10 ${profileName} mantém gates P0 de reset exatos e sem wildcard`, () => {
        const contract = loadF10CiContract();
        const profile = contract.profiles[profileName];
        const byId = new Map(profile.gates.map((gate) => [gate.id, gate]));

        for (const [gateId, expectedCommand] of Object.entries(REQUIRED_RESET_GATES)) {
            const gate = byId.get(gateId);
            assert.ok(gate, `${profileName} perdeu ${gateId}`);
            assert.deepEqual(gate.command, expectedCommand, `${profileName}/${gateId} sofreu command drift`);
            assert.equal(gate.command.some((part) => String(part).includes('*')), false, `${profileName}/${gateId} usa wildcard`);
        }
    });
}

test('gates P0 usam arquivos distintos e owners reais, não um agregador hardcoded', () => {
    const commands = Object.values(REQUIRED_RESET_GATES).map((command) => command.join(' '));
    assert.ok(commands.some((command) => command.includes('f10MigrationBootstrap.test.js')));
    assert.ok(commands.some((command) => command.includes('globalResetJournalFreeze.test.js')));
    assert.ok(commands.some((command) => command.includes('f10BackupRestoreDrill.test.js')));
    assert.ok(commands.some((command) => command.includes('globalPlayerResetService.test.js')));
    assert.ok(commands.some((command) => command.includes('globalPlayerResetRecovery.test.js')));
    assert.ok(commands.some((command) => command.includes('globalPlayerResetEventBinding.test.js')));
    assert.ok(commands.some((command) => command.includes('resetGoNoGoSmoke.test.js')));
    assert.equal(commands.some((command) => /checkResetGoNoGo\.js/.test(command)), false, 'F10 não pode usar o próprio agregador como única evidência');
});
