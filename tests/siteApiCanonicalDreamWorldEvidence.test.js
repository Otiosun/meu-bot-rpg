'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalRuntimeDescriptors } = require('../helpers/clover/routeSourceAudit');
const { auditPublicContracts, isCriticalPublicDescriptor } = require('../helpers/clover/siteApiContractAudit');
const {
    DREAM_WORLDS_CANONICAL_TARGETS,
    auditCriticalContractEvidence,
    buildCriticalContractEvidence,
} = require('../helpers/clover/siteApiCriticalContractEvidence');
const { __test } = require('../helpers/clover/siteApiHandlerBoundaryProbes');

const IDS = Object.freeze(Object.keys(DREAM_WORLDS_CANONICAL_TARGETS));

function audit(captures, evidence = undefined) {
    const all = canonicalRuntimeDescriptors();
    const descriptors = all.filter((descriptor) => IDS.includes(descriptor.id));
    return auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, evidence, {
        captures,
        registry: auditPublicContracts(all).registry,
    });
}

function reason(result, descriptorId) {
    return result.unproven.find((entry) => entry.descriptorId === descriptorId)?.reason;
}

test('canonical Dream Worlds descriptors cross session-authenticated real handlers and SQLite semantic owners', async () => {
    const captures = await __test.runDreamWorldsCanonicalProbes();
    assert.equal(captures.length, IDS.length);
    for (const capture of captures) {
        assert.equal(capture.outcome, 'MATCHED_SUCCESS', `${capture.name}: ${capture.status} ${capture.error || ''}`);
        assert.ok(capture.status >= 200 && capture.status < 300, capture.name);
    }
    assert.deepEqual(audit(captures).proven.sort(), [...IDS].sort());
});

test('canonical Dream Worlds evidence rejects method, path, body, response and family drift', async () => {
    const captures = await __test.runDreamWorldsCanonicalProbes();
    const read = (overrides = {}, evidence = undefined) => audit(captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })), evidence);
    const application = captures.find((capture) => capture.name === 'dream-application-submit');
    const request = captures.find((capture) => capture.name === 'dream-request-submit');
    const invite = captures.find((capture) => capture.name === 'dream-invite-accept');
    assert.equal(reason(read({ 'dream-application-submit': { request: { ...application.request, method: 'PUT' } } }), 'dream-worlds.application.submit'), 'path_schema_mismatch');
    assert.equal(reason(read({ 'dream-application-withdraw': { request: { method: 'POST', url: '/dream-worlds/applications/not-a-number', body: {} } } }), 'dream-worlds.application.withdraw'), 'path_schema_mismatch');
    assert.equal(reason(read({ 'dream-request-submit': { request: { ...request.request, body: { buyerType: 'player' } } } }), 'dream-worlds.request.submit'), 'body_mode_or_schema_mismatch');
    assert.equal(reason(read({ 'dream-invite-accept': { payload: { ok: true } } }), 'dream-worlds.invite.accept'), 'real_response_schema_mismatch');
    const evidence = buildCriticalContractEvidence(canonicalRuntimeDescriptors(), isCriticalPublicDescriptor)
        .filter((entry) => IDS.includes(entry.descriptorId))
        .map((entry) => entry.descriptorId === 'dream-worlds.invite.decline' ? { ...entry, familyId: 'wrong-dream-family' } : entry);
    assert.equal(reason(read({}, evidence), 'dream-worlds.invite.decline'), 'family_or_contract_misclassified');
    assert.equal(reason(read({ 'dream-invite-accept': { contractShapeId: invite.contractShapeId.replace('accept', 'decline') } }), 'dream-worlds.invite.accept'), 'capture_not_correlated');
});
