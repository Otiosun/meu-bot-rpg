'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');
const { loadPreResetProductDecisionManifest } = require('../helpers/clover/preResetProductDecisionService');
const { evaluatePreResetLaunchReadiness } = require('../helpers/clover/preResetReadinessService');

const canonicalPath = path.resolve(__dirname, '..', 'data', 'clover', 'preResetProductDecisions.json');
const syntheticPath = path.resolve(__dirname, 'fixtures', 'preResetProductDecisions.synthetic.json');
const fullySupported = Object.freeze(Object.fromEntries(
    ['D01','D02','D03','D04','D05','D06','D07','D08','D09'].map((id) => [id, Object.freeze({ status: 'SUPPORTED_NOW' })])
));
function clone(value) { return JSON.parse(JSON.stringify(value)); }

test('abertura PRE_RESET nao depende das decisoes de PH/Loja PR fora do escopo', () => {
    const readiness = evaluatePreResetLaunchReadiness(loadPreResetProductDecisionManifest(canonicalPath), {
        frontendIntegrated: true,
        activationAuthorized: true,
        supportMatrix: fullySupported,
    });
    assert.equal(readiness.ready, true);
    assert.equal(readiness.productDecisionsResolved, false);
    assert.equal(readiness.requireProductDecisions, false);
    assert.deepEqual(readiness.unresolved, ['D01','D02','D03','D04','D05','D06','D07','D08','D09']);
    assert.deepEqual(readiness.blockers, []);
});

test('gate posterior de economia/reset continua bloqueando enquanto D01-D09 estiverem unresolved', () => {
    const readiness = evaluatePreResetLaunchReadiness(loadPreResetProductDecisionManifest(canonicalPath), {
        frontendIntegrated: true,
        activationAuthorized: true,
        supportMatrix: fullySupported,
        requireProductDecisions: true,
    });
    assert.equal(readiness.ready, false);
    assert.match(readiness.blockers.join(';'), /UNRESOLVED_DECISIONS=D01,D02,D03,D04,D05,D06,D07,D08,D09/);
});

test('uma unica decisao unresolved derruba somente o gate que exige decisoes de produto', () => {
    const manifest = clone(loadPreResetProductDecisionManifest(syntheticPath));
    delete manifest.testOnly;
    manifest.decisions[4].status = 'UNRESOLVED';
    manifest.decisions[4].value = null;

    const transitionReadiness = evaluatePreResetLaunchReadiness(manifest, {
        frontendIntegrated: true,
        activationAuthorized: true,
        supportMatrix: fullySupported,
    });
    assert.equal(transitionReadiness.ready, true);
    assert.deepEqual(transitionReadiness.unresolved, ['D05']);

    const productReadiness = evaluatePreResetLaunchReadiness(manifest, {
        frontendIntegrated: true,
        activationAuthorized: true,
        supportMatrix: fullySupported,
        requireProductDecisions: true,
    });
    assert.equal(productReadiness.ready, false);
    assert.deepEqual(productReadiness.unresolved, ['D05']);
});

test('frontend externo sozinho impede PASS quando demais criterios de transicao estao satisfeitos', () => {
    const manifest = clone(loadPreResetProductDecisionManifest(syntheticPath));
    delete manifest.testOnly;
    const readiness = evaluatePreResetLaunchReadiness(manifest, {
        frontendIntegrated: false,
        activationAuthorized: true,
        supportMatrix: fullySupported,
    });
    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.blockers, ['FRONTEND_EXTERNAL=YES']);
    assert.equal(evaluatePreResetLaunchReadiness(manifest, {
        frontendIntegrated: true,
        activationAuthorized: true,
        supportMatrix: fullySupported,
    }).ready, true);
});

test('fixture TEST-ONLY e suporte futuro bloqueiam o gate posterior de produto, nao a transicao', () => {
    const transitionReadiness = evaluatePreResetLaunchReadiness(loadPreResetProductDecisionManifest(syntheticPath), {
        frontendIntegrated: true,
        activationAuthorized: true,
    });
    assert.equal(transitionReadiness.ready, true);
    assert.equal(transitionReadiness.testOnlyManifest, true);
    assert.deepEqual(transitionReadiness.supportGaps, []);

    const productReadiness = evaluatePreResetLaunchReadiness(loadPreResetProductDecisionManifest(syntheticPath), {
        frontendIntegrated: true,
        activationAuthorized: true,
        requireProductDecisions: true,
    });
    assert.equal(productReadiness.ready, false);
    assert.equal(productReadiness.testOnlyManifest, true);
    assert.deepEqual(productReadiness.supportGaps, ['D07', 'D08']);
    assert.match(productReadiness.blockers.join(';'), /TEST_ONLY_MANIFEST=YES/);
    assert.match(productReadiness.blockers.join(';'), /UNVERIFIED_IMPLEMENTATION_SUPPORT=D07,D08/);
});
