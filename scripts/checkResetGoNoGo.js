'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { isPreResetLaunchEnabled } = require('../helpers/clover/preResetAccessService');
const { loadPreResetProductDecisionManifest } = require('../helpers/clover/preResetProductDecisionService');
const { evaluatePreResetLaunchReadiness } = require('../helpers/clover/preResetReadinessService');
const { evaluateResetGoNoGoDecision } = require('../helpers/ci/resetGoNoGoDecision');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT_PATH = path.join(ROOT, 'config', 'reset-go-no-go-contract.json');
const EXPECTED_P0_IDS = [
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

function fail(message, code = 'reset_gate_contract_error') {
    const error = new Error(message);
    error.code = code;
    throw error;
}

function loadContract() {
    const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
    if (contract.schemaVersion !== 'reset-go-no-go-v1') fail('schemaVersion inválido.');
    if (contract.policy?.failClosed !== true || contract.policy?.allP0ItemsRequired !== true) {
        fail('Contrato não está fail-closed.');
    }
    if (contract.policy?.explicitExecutionAuthorizationRequired !== true) {
        fail('Contrato não exige autorização operacional final.', 'reset_gate_execution_authorization_not_required');
    }
    const ids = (contract.p0 || []).map((item) => item.id);
    if (JSON.stringify([...ids].sort()) !== JSON.stringify([...EXPECTED_P0_IDS].sort())) {
        fail('Conjunto P0 divergiu dos 14 itens canônicos.', 'reset_gate_p0_set_drift');
    }
    if (new Set(ids).size !== ids.length) fail('P0 duplicado.', 'reset_gate_duplicate_p0');
    for (const item of contract.p0) {
        if (!Array.isArray(item.requires) || !item.requires.length) {
            fail(`P0 sem gate: ${item.id}.`, 'reset_gate_p0_without_evidence');
        }
        for (const gateId of item.requires) {
            const gate = contract.gates?.[gateId];
            if (!gate || !Array.isArray(gate.command) || !gate.command.length) {
                fail(`Gate inexistente/inválido: ${gateId}.`, 'reset_gate_unknown_gate');
            }
            if (gate.command.some((arg) => String(arg).includes('*'))) {
                fail(`Wildcard proibido no gate ${gateId}.`, 'reset_gate_wildcard_forbidden');
            }
        }
    }
    return contract;
}

function gateEnv() {
    const env = { ...process.env, NODE_ENV: 'test' };
    delete env.PRE_RESET_LAUNCH_ENABLED;
    delete env.PRE_RESET_FRONTEND_INTEGRATED;
    delete env.CLOVER_GLOBAL_RESET_ENABLED;
    delete env.CLOVER_GLOBAL_RESET_OPERATION_ID;
    delete env.CLOVER_GLOBAL_RESET_RECOVER_EXECUTION;
    delete env.CLOVER_RESET_EXECUTION_AUTHORIZED;
    return env;
}

function runGate(gateId, gate) {
    const command = gate.command;
    const executable = command[0] === 'npm' && process.platform === 'win32' ? 'npm.cmd' : command[0];
    const args = command.slice(1);
    const started = Date.now();
    const run = spawnSync(executable, args, {
        cwd: ROOT,
        env: gateEnv(),
        encoding: 'utf8',
        shell: false,
        maxBuffer: 32 * 1024 * 1024,
    });
    const result = {
        gateId,
        pass: !run.error && run.status === 0,
        exit: run.status,
        durationMs: Date.now() - started,
        error: run.error?.message || null,
    };
    console.log(`\n[RESET_GO_NO_GO] ${result.pass ? 'PASS' : 'FAIL'} ${gateId} (${result.durationMs}ms)`);
    if (run.stdout) process.stdout.write(run.stdout);
    if (run.stderr) process.stderr.write(run.stderr);
    if (run.error) console.error(`SPAWN_ERROR=${run.error.message}`);
    return result;
}

function percent(value, total) {
    return total ? Math.floor((value / total) * 100) : 0;
}

function main() {
    const reportOnly = process.argv.includes('--report-only');
    const contract = loadContract();
    const gateResults = new Map();
    for (const [gateId, gate] of Object.entries(contract.gates)) {
        gateResults.set(gateId, runGate(gateId, gate));
    }

    const itemResults = contract.p0.map((item) => {
        const failed = item.requires.filter((gateId) => !gateResults.get(gateId)?.pass);
        return {
            id: item.id,
            label: item.label,
            pass: failed.length === 0,
            failedGates: failed,
        };
    });

    const manifest = loadPreResetProductDecisionManifest();
    const readiness = evaluatePreResetLaunchReadiness(manifest, {
        frontendIntegrated: false,
        activationAuthorized: false,
    });
    const productResolved = readiness.productDecisionsResolved === true;
    const unresolved = Array.isArray(readiness.unresolved) ? readiness.unresolved : [];
    const defaultPreResetOff = isPreResetLaunchEnabled({}) === false;
    const currentPreResetOff = isPreResetLaunchEnabled(process.env) === false;
    const currentGlobalResetSwitchOff = String(process.env.CLOVER_GLOBAL_RESET_ENABLED || '').trim().toUpperCase() !== 'YES';
    const executionAuthorized = String(process.env.CLOVER_RESET_EXECUTION_AUTHORIZED || '').trim().toUpperCase() === 'YES';

    const decision = evaluateResetGoNoGoDecision({
        itemResults,
        productResolved,
        unresolved,
        defaultPreResetOff,
        currentPreResetOff,
        currentGlobalResetSwitchOff,
        executionAuthorized,
    });

    console.log('\n=== RESET GO/NO-GO SUMMARY ===');
    console.log(`P0_PASS=${decision.passedP0}/${decision.totalP0}`);
    console.log(`P0_PROGRESS_PERCENT=${percent(decision.passedP0, decision.totalP0)}`);
    console.log(`PRODUCT_DECISIONS_RESOLVED=${productResolved ? 'YES' : 'NO'}`);
    console.log(`UNRESOLVED_DECISIONS=${unresolved.join(',') || 'NONE'}`);
    console.log(`PRE_RESET_MODE_DEFAULT_OFF=${defaultPreResetOff ? 'YES' : 'NO'}`);
    console.log(`PRE_RESET_CURRENTLY_OFF=${currentPreResetOff ? 'YES' : 'NO'}`);
    console.log(`GLOBAL_RESET_MUTATION_SWITCH_OFF=${currentGlobalResetSwitchOff ? 'YES' : 'NO'}`);
    console.log(`ACTIVATION_AUTHORIZED=${executionAuthorized ? 'YES' : 'NO'}`);
    console.log(`BLOCKERS=${decision.blockers.join(';') || 'NONE'}`);
    console.log(`RESET_GO_NO_GO=${decision.go ? 'GO' : 'NO_GO'}`);

    if (!decision.go && !reportOnly) process.exitCode = 2;
}

try {
    main();
} catch (error) {
    console.error('RESET_GO_NO_GO=NO_GO');
    console.error(`BLOCKER=${error.code || 'reset_gate_exception'}:${error.message}`);
    if (!process.argv.includes('--report-only')) process.exitCode = 2;
}
