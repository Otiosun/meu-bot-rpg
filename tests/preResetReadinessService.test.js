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

test('canonical nunca fica launch-ready enquanto D01-D09 seguem unresolved', () => {
    const readiness = evaluatePreResetLaunchReadiness(loadPreResetProductDecisionManifest(canonicalPath), {
        frontendIntegrated: true,
        activationAuthorized: true,
        supportMatrix: fullySupported,
    });
    assert.equal(readiness.ready, false);
    assert.match(readiness.blockers.join(';'), /UNRESOLVED_DECISIONS=D01,D02,D03,D04,D05,D06,D07,D08,D09/);
});

test('uma unica decisao unresolved derruba o gate', () => {
    const manifest = clone(loadPreResetProductDecisionManifest(syntheticPath));
    delete manifest.testOnly;
    manifest.decisions[4].status = 'UNRESOLVED';
    manifest.decisions[4].value = null;
    const readiness = evaluatePreResetLaunchReadiness(manifest, { frontendIntegrated: true, activationAuthorized: true, supportMatrix: fullySupported });
    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.unresolved, ['D05']);
});

test('frontend externo sozinho impede PASS quando demais criterios estao satisfeitos', () => {
    const manifest = clone(loadPreResetProductDecisionManifest(syntheticPath));
    delete manifest.testOnly;
    const readiness = evaluatePreResetLaunchReadiness(manifest, { frontendIntegrated: false, activationAuthorized: true, supportMatrix: fullySupported });
    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.blockers, ['FRONTEND_EXTERNAL=YES']);
    assert.equal(evaluatePreResetLaunchReadiness(manifest, { frontendIntegrated: true, activationAuthorized: true, supportMatrix: fullySupported }).ready, true);
});

test('fixture TEST-ONLY e suporte ainda nao implementado nunca viram launch PASS', () => {
    const readiness = evaluatePreResetLaunchReadiness(loadPreResetProductDecisionManifest(syntheticPath), {
        frontendIntegrated: true,
        activationAuthorized: true,
    });
    assert.equal(readiness.ready, false);
    assert.equal(readiness.testOnlyManifest, true);
    assert.deepEqual(readiness.supportGaps, ['D07', 'D08']);
    assert.match(readiness.blockers.join(';'), /TEST_ONLY_MANIFEST=YES/);
    assert.match(readiness.blockers.join(';'), /UNVERIFIED_IMPLEMENTATION_SUPPORT=D07,D08/);
});
