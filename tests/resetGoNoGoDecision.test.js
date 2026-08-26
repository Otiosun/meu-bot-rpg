'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { evaluateResetGoNoGoDecision } = require('../helpers/ci/resetGoNoGoDecision');

function allPass() {
    return Array.from({ length: 14 }, (_, index) => ({
        id: `p0_${index + 1}`,
        pass: true,
        failedGates: [],
    }));
}

function safeBase(overrides = {}) {
    return {
        itemResults: allPass(),
        productResolved: true,
        unresolved: [],
        productSupportGaps: [],
        productManifestTestOnly: false,
        defaultPreResetOff: true,
        currentPreResetOff: true,
        currentGlobalResetSwitchOff: true,
        executionAuthorized: true,
        ...overrides,
    };
}

test('D01-D09 unresolved força NO_GO mesmo com 14/14 técnico', () => {
    const unresolved = ['D01','D02','D03','D04','D05','D06','D07','D08','D09'];
    const decision = evaluateResetGoNoGoDecision(safeBase({
        productResolved: false,
        unresolved,
    }));
    assert.equal(decision.passedP0, 14);
    assert.equal(decision.go, false);
    assert.ok(decision.blockers.includes(`product_decisions_unresolved:${unresolved.join(',')}`));
});

test('produto aprovado ainda força NO_GO enquanto readiness reportar gaps runtime reais', () => {
    const decision = evaluateResetGoNoGoDecision(safeBase({
        productResolved: true,
        productSupportGaps: ['D07', 'D08', 'D07'],
    }));
    assert.equal(decision.passedP0, 14);
    assert.equal(decision.go, false);
    assert.ok(decision.blockers.includes('product_runtime_support_incomplete:D07,D08'));
});

test('manifesto test-only nunca pode autorizar RESET real', () => {
    const decision = evaluateResetGoNoGoDecision(safeBase({
        productManifestTestOnly: true,
    }));
    assert.equal(decision.go, false);
    assert.ok(decision.blockers.includes('product_manifest_test_only'));
});

test('autorização operacional ausente força NO_GO mesmo com técnico e produto verdes', () => {
    const decision = evaluateResetGoNoGoDecision(safeBase({ executionAuthorized: false }));
    assert.equal(decision.go, false);
    assert.ok(decision.blockers.includes('reset_execution_not_explicitly_authorized'));
});

test('um único P0 vermelho força NO_GO e preserva identificação do gate falho', () => {
    const items = allPass();
    items[7] = { id: 'resume_after_failure', pass: false, failedGates: ['global-reset-orchestrator'] };
    const decision = evaluateResetGoNoGoDecision(safeBase({ itemResults: items }));
    assert.equal(decision.passedP0, 13);
    assert.equal(decision.go, false);
    assert.ok(decision.blockers.includes('p0:resume_after_failure:global-reset-orchestrator'));
});

test('switch de mutação ligado durante o gate força NO_GO', () => {
    const decision = evaluateResetGoNoGoDecision(safeBase({ currentGlobalResetSwitchOff: false }));
    assert.equal(decision.go, false);
    assert.ok(decision.blockers.includes('global_reset_mutation_switch_enabled_during_gate'));
});

test('GO só existe com 14/14, produto resolvido e suportado, pre-reset OFF, mutation switch OFF e autorização explícita', () => {
    const decision = evaluateResetGoNoGoDecision(safeBase());
    assert.equal(decision.passedP0, 14);
    assert.equal(decision.totalP0, 14);
    assert.deepEqual(decision.blockers, []);
    assert.equal(decision.go, true);
});
