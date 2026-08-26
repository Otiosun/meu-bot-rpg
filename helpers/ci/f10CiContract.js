'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CONTRACT_PATH = path.join(ROOT, 'config', 'f10-ci-contract.json');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'f10-definitive-ci.yml');
const CANONICAL_MIGRATION_GATE_ID = 'canonical-migration-bootstrap';

const REQUIRED_CATEGORIES = Object.freeze([
    'lint', 'syntax', 'typecheck', 'unit_tests', 'domain_tests', 'contract_tests',
    'authorization_tests', 'real_sqlite', 'migration_fresh_db', 'migration_legacy_db',
    'integration_tests', 'critical_e2e', 'frontend_build', 'backend_build',
    'dependency_scanning', 'secret_scanning', 'static_security_analysis', 'reproducibility_checks',
]);
const STATUS_VALUES = Object.freeze(['COVERED', 'PARTIAL', 'GAP', 'EXTERNAL', 'DEFERRED_F11']);
const REMOTE_SIGNAL_VALUES = Object.freeze(['UNAVAILABLE_PRE_RUNNER', 'AVAILABLE_VERIFIED']);
const PROFILE_RUNNERS = Object.freeze({ 'linux-main': 'ubuntu-latest', 'windows-critical': 'windows-latest' });
const WINDOWS_REQUIRED_CATEGORIES = Object.freeze([
    'syntax', 'contract_tests', 'authorization_tests', 'real_sqlite', 'migration_fresh_db',
    'migration_legacy_db', 'critical_e2e', 'reproducibility_checks',
]);
const CANONICAL_MIGRATION_COMMAND = Object.freeze([
    'node', '--test', 'tests/f10MigrationBootstrap.test.js', 'tests/globalResetJournalFreeze.test.js',
]);

class F10CiContractError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'F10CiContractError';
        this.code = code;
        this.details = details;
    }
}

function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function fail(code, message, details) { throw new F10CiContractError(code, message, details); }
function readJson(filename) { return JSON.parse(fs.readFileSync(filename, 'utf8')); }

function validateCommand(command, gateId) {
    if (!Array.isArray(command) || command.length < 2 || command.some((part) => typeof part !== 'string' || !part.trim())) {
        fail('invalid_gate_command', `Comando inválido em ${gateId}.`);
    }
    if (!['node', 'npm'].includes(command[0])) fail('unsafe_gate_executable', `Executável não permitido em ${gateId}: ${command[0]}.`);
}

function validateCanonicalMigrationGate(profileName, profile) {
    const gate = profile.gates.find((candidate) => candidate.id === CANONICAL_MIGRATION_GATE_ID);
    if (!gate) fail('missing_canonical_migration_gate', `${profileName} precisa executar ${CANONICAL_MIGRATION_GATE_ID}.`);

    if (JSON.stringify(gate.command) !== JSON.stringify(CANONICAL_MIGRATION_COMMAND)) {
        fail('canonical_migration_command_drift', `Comando canônico de migration divergiu em ${profileName}.`);
    }

    const required = ['real_sqlite', 'migration_fresh_db', 'migration_legacy_db', 'reproducibility_checks'];
    const observed = new Set(gate.categories);
    for (const category of required) {
        if (!observed.has(category)) {
            fail('canonical_migration_category_gap', `${profileName}/${CANONICAL_MIGRATION_GATE_ID} não cobre ${category}.`);
        }
    }
}

function validateF10CiContract(input) {
    if (!plainObject(input)) fail('invalid_contract', 'Contrato F10 inválido.');
    if (input.schemaVersion !== 'f10-ci-contract-v1') fail('invalid_schema_version', 'schemaVersion F10 inválida.');
    if (input.phase !== 'F10') fail('invalid_phase', 'Contrato precisa declarar phase=F10.');
    if (input.nodeVersionFile !== '.node-version') fail('node_version_authority_drift', 'nodeVersionFile deve ser .node-version.');
    if (input.workflowPath !== '.github/workflows/f10-definitive-ci.yml') fail('workflow_authority_drift', 'workflowPath canônico divergente.');

    if (!plainObject(input.remoteSignal) || !REMOTE_SIGNAL_VALUES.includes(input.remoteSignal.status)) fail('invalid_remote_signal', 'Estado do sinal remoto F10 inválido.');
    if (input.remoteSignal.status === 'AVAILABLE_VERIFIED' && !String(input.remoteSignal.evidence || '').trim()) fail('remote_signal_without_evidence', 'Sinal remoto AVAILABLE_VERIFIED exige evidência.');
    if (!plainObject(input.syntaxScope) || !Array.isArray(input.syntaxScope.roots) || !input.syntaxScope.roots.length) fail('invalid_syntax_scope', 'syntaxScope precisa de roots explícitos.');

    if (!plainObject(input.categories)) fail('invalid_categories', 'Categorias F10 ausentes.');
    const categoryKeys = Object.keys(input.categories).sort();
    const expectedKeys = [...REQUIRED_CATEGORIES].sort();
    if (JSON.stringify(categoryKeys) !== JSON.stringify(expectedKeys)) {
        fail('category_set_drift', 'Contrato precisa conter exatamente as categorias canônicas da Fase 10.', {
            missing: expectedKeys.filter((key) => !categoryKeys.includes(key)),
            unknown: categoryKeys.filter((key) => !expectedKeys.includes(key)),
        });
    }
    for (const category of REQUIRED_CATEGORIES) {
        const item = input.categories[category];
        if (!plainObject(item) || !STATUS_VALUES.includes(item.status) || !String(item.detail || '').trim()) fail('invalid_category', `Categoria F10 inválida: ${category}.`);
    }

    if (!plainObject(input.profiles)) fail('invalid_profiles', 'Perfis F10 ausentes.');
    const profileKeys = Object.keys(input.profiles).sort();
    const expectedProfiles = Object.keys(PROFILE_RUNNERS).sort();
    if (JSON.stringify(profileKeys) !== JSON.stringify(expectedProfiles)) fail('profile_set_drift', 'Perfis F10 precisam ser exatamente linux-main e windows-critical.');

    const coverageByProfile = {};
    for (const [profileName, expectedRunner] of Object.entries(PROFILE_RUNNERS)) {
        const profile = input.profiles[profileName];
        if (!plainObject(profile) || profile.runner !== expectedRunner || profile.requiredForF10 !== true) fail('invalid_profile', `Perfil inválido: ${profileName}.`);
        if (!Array.isArray(profile.gates) || !profile.gates.length) fail('empty_profile', `Perfil sem gates: ${profileName}.`);
        const gateIds = new Set();
        const covered = new Set();
        for (const gate of profile.gates) {
            if (!plainObject(gate) || !String(gate.id || '').trim()) fail('invalid_gate', `Gate inválido em ${profileName}.`);
            if (gateIds.has(gate.id)) fail('duplicate_gate', `Gate duplicado em ${profileName}: ${gate.id}.`);
            gateIds.add(gate.id);
            if (!Array.isArray(gate.categories) || !gate.categories.length) fail('gate_without_categories', `Gate sem categorias: ${gate.id}.`);
            for (const category of gate.categories) {
                if (!REQUIRED_CATEGORIES.includes(category)) fail('unknown_gate_category', `Categoria desconhecida em ${gate.id}: ${category}.`);
                covered.add(category);
            }
            validateCommand(gate.command, gate.id);
        }
        if (!gateIds.has('ci-contract')) fail('missing_ci_contract_gate', `${profileName} precisa executar ci-contract.`);
        validateCanonicalMigrationGate(profileName, profile);
        coverageByProfile[profileName] = covered;
    }

    for (const category of WINDOWS_REQUIRED_CATEGORIES) {
        if (!coverageByProfile['windows-critical'].has(category)) fail('windows_critical_coverage_gap', `Windows-critical não cobre categoria obrigatória: ${category}.`);
    }
    for (const category of REQUIRED_CATEGORIES) {
        if (input.categories[category].status === 'COVERED' && !coverageByProfile['linux-main'].has(category)) fail('covered_without_linux_gate', `Categoria marcada COVERED sem gate Linux: ${category}.`);
    }
    return Object.freeze(input);
}

function loadF10CiContract(filename = CONTRACT_PATH) { return validateF10CiContract(readJson(filename)); }

function summarizeF10CiContract(contract) {
    const validated = validateF10CiContract(contract);
    const counts = {};
    const blockers = [];
    for (const category of REQUIRED_CATEGORIES) {
        const status = validated.categories[category].status;
        counts[status] = (counts[status] || 0) + 1;
        if (status !== 'COVERED') blockers.push(`${category}:${status}`);
    }
    if (validated.remoteSignal.status !== 'AVAILABLE_VERIFIED') blockers.push(`remote_ci:${validated.remoteSignal.status}`);
    return Object.freeze({ categoryTotal: REQUIRED_CATEGORIES.length, counts: Object.freeze(counts), blockers: Object.freeze(blockers), remoteSignal: validated.remoteSignal.status, ready: blockers.length === 0 });
}

function auditF10WorkflowText(text) {
    const source = String(text || '');
    const failures = [];
    const requiredSnippets = [
        'name: F10 definitive CI', 'pull_request:', '- main', 'workflow_dispatch:', 'permissions:', 'contents: read',
        'linux-main:', 'runs-on: ubuntu-latest', 'windows-critical:', 'runs-on: windows-latest',
        "node-version-file: '.node-version'", 'npm ci --no-audit --no-fund',
        'node scripts/runF10CiProfile.js linux-main', 'node scripts/runF10CiProfile.js windows-critical',
    ];
    for (const snippet of requiredSnippets) if (!source.includes(snippet)) failures.push(`missing:${snippet}`);
    if (/continue-on-error\s*:\s*true/i.test(source)) failures.push('continue_on_error_true');
    if (/(?:^|\s)\|\|\s*true(?:\s|$)/m.test(source)) failures.push('shell_true_bypass');
    if (/PRE_RESET_LAUNCH_ENABLED\s*:\s*['"]?true/i.test(source)) failures.push('unsafe_prereset_activation');
    return Object.freeze({ pass: failures.length === 0, failures: Object.freeze(failures) });
}

function auditCanonicalF10Workflow(filename = WORKFLOW_PATH) { return auditF10WorkflowText(fs.readFileSync(filename, 'utf8')); }

module.exports = {
    CANONICAL_MIGRATION_COMMAND,
    CANONICAL_MIGRATION_GATE_ID,
    CONTRACT_PATH,
    F10CiContractError,
    PROFILE_RUNNERS,
    REQUIRED_CATEGORIES,
    STATUS_VALUES,
    WINDOWS_REQUIRED_CATEGORIES,
    WORKFLOW_PATH,
    auditCanonicalF10Workflow,
    auditF10WorkflowText,
    loadF10CiContract,
    summarizeF10CiContract,
    validateF10CiContract,
};
