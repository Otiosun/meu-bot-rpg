'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {
    F10CiContractError,
    REQUIRED_CATEGORIES,
    auditCanonicalF10Workflow,
    auditF10WorkflowText,
    loadF10CiContract,
    summarizeF10CiContract,
    validateF10CiContract,
} = require('../helpers/ci/f10CiContract');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

test('contrato F10 contém exatamente as categorias do Plano Mestre e permanece truthful NOT READY', () => {
    const contract = loadF10CiContract();
    assert.deepEqual(Object.keys(contract.categories).sort(), [...REQUIRED_CATEGORIES].sort());
    const summary = summarizeF10CiContract(contract);
    assert.equal(summary.ready, false);
    assert.equal(summary.remoteSignal, 'UNAVAILABLE_PRE_RUNNER');
    assert.ok(summary.blockers.includes('lint:GAP'));
    assert.ok(summary.blockers.includes('typecheck:GAP'));
    assert.ok(summary.blockers.includes('frontend_build:EXTERNAL'));
    assert.ok(summary.blockers.includes('remote_ci:UNAVAILABLE_PRE_RUNNER'));
});

test('categoria ausente ou inventada falha fechado', () => {
    const canonical = loadF10CiContract();
    const missing = clone(canonical);
    delete missing.categories.syntax;
    assert.throws(() => validateF10CiContract(missing), (error) => error instanceof F10CiContractError && error.code === 'category_set_drift');
    const unknown = clone(canonical);
    unknown.categories.magic_green = { status: 'COVERED', detail: 'fake' };
    assert.throws(() => validateF10CiContract(unknown), (error) => error instanceof F10CiContractError && error.code === 'category_set_drift');
});

test('COVERED sem gate Linux correspondente é false-green e é rejeitado', () => {
    const candidate = clone(loadF10CiContract());
    candidate.categories.lint.status = 'COVERED';
    assert.throws(() => validateF10CiContract(candidate), (error) => error instanceof F10CiContractError && error.code === 'covered_without_linux_gate');
});

test('Windows crítico não pode perder SQLite/contratos/auth/E2E/reprodutibilidade', () => {
    const candidate = clone(loadF10CiContract());
    candidate.profiles['windows-critical'].gates = candidate.profiles['windows-critical'].gates.filter((gate) => !gate.categories.includes('real_sqlite'));
    assert.throws(() => validateF10CiContract(candidate), (error) => error instanceof F10CiContractError && error.code === 'windows_critical_coverage_gap');
});

test('sinal remoto só vira AVAILABLE_VERIFIED com evidência explícita', () => {
    const candidate = clone(loadF10CiContract());
    candidate.remoteSignal = { status: 'AVAILABLE_VERIFIED', evidence: '' };
    assert.throws(() => validateF10CiContract(candidate), (error) => error instanceof F10CiContractError && error.code === 'remote_signal_without_evidence');
});

test('workflow canônico cobre Linux + Windows, usa lockfile e não possui bypass', () => {
    const audit = auditCanonicalF10Workflow();
    assert.equal(audit.pass, true, audit.failures.join(','));
});

test('workflow audit detecta remoção de Windows e continue-on-error', () => {
    const canonical = fs.readFileSync(require('../helpers/ci/f10CiContract').WORKFLOW_PATH, 'utf8');
    const withoutWindows = canonical.replace('runs-on: windows-latest', 'runs-on: ubuntu-latest');
    assert.equal(auditF10WorkflowText(withoutWindows).pass, false);
    const bypass = `${canonical}\n# injected\ncontinue-on-error: true\n`;
    const audit = auditF10WorkflowText(bypass);
    assert.equal(audit.pass, false);
    assert.ok(audit.failures.includes('continue_on_error_true'));
});
