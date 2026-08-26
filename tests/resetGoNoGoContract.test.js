'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT_PATH = path.join(ROOT, 'config', 'reset-go-no-go-contract.json');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'checkResetGoNoGo.js');
const EXPECTED_P0 = [
    'migrations_fresh_db',
    'migrations_legacy_db',
    'backup_real',
    'restore_real',
    'global_reset_safe',
    'idempotency',
    'journal_progress',
    'resume_after_failure',
    'reconciliation',
    'rollback_recovery',
    'auth_admin',
    'kill_switches',
    'final_smoke',
    'single_reset_go_no_go',
];
const EXPECTED_DECISIONS = ['D01','D02','D03','D04','D05','D06','D07','D08','D09'];

function load() {
    return JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
}

test('RESET_GO_NO_GO contract contém exatamente os 14 P0 canônicos', () => {
    const contract = load();
    assert.equal(contract.schemaVersion, 'reset-go-no-go-v1');
    assert.equal(contract.policy.failClosed, true);
    assert.equal(contract.policy.allP0ItemsRequired, true);
    assert.equal(contract.policy.explicitExecutionAuthorizationRequired, true);
    assert.deepEqual(contract.p0.map((item) => item.id).sort(), [...EXPECTED_P0].sort());
    assert.equal(new Set(contract.p0.map((item) => item.id)).size, 14);
});

test('D01-D09 são blockers externos exatos e não podem sumir do contrato', () => {
    const contract = load();
    assert.equal(contract.policy.productDecisionsD01D09Required, true);
    assert.deepEqual(contract.productDecisionBlockers, EXPECTED_DECISIONS);
});

test('todo P0 depende de evidência explícita e nenhum comando usa wildcard', () => {
    const contract = load();
    for (const item of contract.p0) {
        assert.ok(Array.isArray(item.requires) && item.requires.length > 0, `${item.id} sem evidência`);
        for (const gateId of item.requires) {
            const gate = contract.gates[gateId];
            assert.ok(gate, `${item.id} referencia gate inexistente ${gateId}`);
            assert.ok(Array.isArray(gate.command) && gate.command.length >= 2);
            assert.equal(gate.command.some((part) => String(part).includes('*')), false, `${gateId} usa wildcard`);
        }
    }
});

test('gate único executa owners comportamentais reais e não substitui tudo por um PASS agregado', () => {
    const contract = load();
    const commands = Object.fromEntries(Object.entries(contract.gates).map(([id, gate]) => [id, gate.command.join(' ')]));
    assert.match(commands['migration-bootstrap'], /f10MigrationBootstrap\.test\.js/);
    assert.match(commands['backup-restore'], /f10BackupRestoreDrill\.test\.js/);
    assert.match(commands['global-reset-orchestrator'], /globalPlayerResetService\.test\.js/);
    assert.match(commands['global-reset-orchestrator'], /globalPlayerResetRecovery\.test\.js/);
    assert.match(commands['final-smoke'], /resetGoNoGoSmoke\.test\.js/);
    assert.equal(fs.existsSync(SCRIPT_PATH), true);
});
