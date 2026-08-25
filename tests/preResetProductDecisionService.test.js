'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');
const {
    DECISION_IDS,
    SUPPORT_MATRIX,
    compileProductionPreResetPolicyRegistry,
    compileTestOnlyPreResetPolicyRegistry,
    loadPreResetProductDecisionManifest,
    summarizePreResetProductDecisions,
    validatePreResetProductDecisionManifest,
} = require('../helpers/clover/preResetProductDecisionService');

const canonical = path.resolve(__dirname, '..', 'data', 'clover', 'preResetProductDecisions.json');
const synthetic = path.resolve(__dirname, 'fixtures', 'preResetProductDecisions.synthetic.json');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

test('manifesto canonico preserva D01-D09 integralmente UNRESOLVED', () => {
    const manifest = loadPreResetProductDecisionManifest(canonical);
    const summary = summarizePreResetProductDecisions(manifest);
    assert.equal(summary.decisionTotal, 9);
    assert.equal(summary.decisionApproved, 0);
    assert.equal(summary.decisionUnresolved, 9);
    assert.deepEqual(summary.unresolved, DECISION_IDS);
    assert.equal(summary.configurationSchemaReady, true);
    assert.equal(summary.productDecisionsResolved, false);
    assert.equal(summary.activationAuthorized, false);
});

test('manifesto rejeita ausencia, desconhecida, duplicata, chave trocada e valor escondido', () => {
    const original = loadPreResetProductDecisionManifest(canonical);
    const missing = clone(original); missing.decisions.pop();
    assert.throws(() => validatePreResetProductDecisionManifest(missing), { code: 'incomplete_manifest' });
    const unknown = clone(original); unknown.decisions[8].id = 'D10';
    assert.throws(() => validatePreResetProductDecisionManifest(unknown), { code: 'unknown_decision' });
    const duplicate = clone(original); duplicate.decisions[8].id = 'D01';
    assert.throws(() => validatePreResetProductDecisionManifest(duplicate), { code: 'duplicate_decision' });
    const keyMismatch = clone(original); keyMismatch.decisions[0].key = 'RESET_SHOP_CATALOG_PRICES';
    assert.throws(() => validatePreResetProductDecisionManifest(keyMismatch), { code: 'decision_key_mismatch' });
    const hidden = clone(original); hidden.decisions[0].value = { rate: 123 };
    assert.throws(() => validatePreResetProductDecisionManifest(hidden), { code: 'unresolved_has_value' });
});

test('APPROVED exige shape e canonical nunca compila policy de producao', () => {
    const original = loadPreResetProductDecisionManifest(canonical);
    const malformed = clone(original);
    malformed.decisions[0] = { ...malformed.decisions[0], status: 'APPROVED', value: {} };
    assert.throws(() => validatePreResetProductDecisionManifest(malformed), { code: 'invalid_decision_value' });
    assert.throws(() => compileProductionPreResetPolicyRegistry(original), { code: 'activation_not_authorized' });
});

test('fixture sintetica compila somente TEST-ONLY e expõe suporte incompleto sem false green', () => {
    const manifest = loadPreResetProductDecisionManifest(synthetic, { requireAllApproved: true });
    const compiled = compileTestOnlyPreResetPolicyRegistry(manifest);
    assert.equal(compiled.registry.testOnly, true);
    assert.equal(compiled.registry.get('PRE_RESET_MODE').enabled, true);
    assert.equal(compiled.registry.get('PH_RETURN_CONVERSION').testOnly, true);
    assert.equal(compiled.registry.get('RESET_SHOP').products.length, 3);
    assert.equal(compiled.behaviorallyComplete, false);
    assert.equal(SUPPORT_MATRIX.D07.status, 'REQUIRES_FUTURE_IMPLEMENTATION');
    assert.equal(SUPPORT_MATRIX.D08.status, 'REQUIRES_FUTURE_IMPLEMENTATION');
});

test('um unico UNRESOLVED impede compilacao ate em fixture sintetica', () => {
    const manifest = clone(loadPreResetProductDecisionManifest(synthetic));
    manifest.decisions[3].status = 'UNRESOLVED';
    manifest.decisions[3].value = null;
    assert.throws(() => compileTestOnlyPreResetPolicyRegistry(manifest), { code: 'product_decisions_unresolved' });
});