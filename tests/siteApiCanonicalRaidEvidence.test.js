'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalRuntimeDescriptors } = require('../helpers/clover/routeSourceAudit');
const { auditPublicContracts, isCriticalPublicDescriptor } = require('../helpers/clover/siteApiContractAudit');
const {
    RAID_CANONICAL_TARGETS,
    auditCriticalContractEvidence,
    buildCriticalContractEvidence,
} = require('../helpers/clover/siteApiCriticalContractEvidence');
const { __test } = require('../helpers/clover/siteApiHandlerBoundaryProbes');

const IDS = Object.freeze(Object.keys(RAID_CANONICAL_TARGETS));

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

test('canonical Raid descriptors reach real disposable-SQLite owners with descriptor-specific responses', async () => {
    const captures = await __test.runRaidCanonicalProbes();
    assert.equal(captures.length, IDS.length);
    for (const capture of captures) {
        assert.equal(capture.outcome, 'MATCHED_SUCCESS', `${capture.name}: ${capture.status} ${capture.error || ''}`);
        assert.ok(capture.status >= 200 && capture.status < 300, capture.name);
    }
    assert.deepEqual(audit(captures).proven.sort(), [...IDS].sort());
});

test('canonical Raid evidence rejects method, path, body, response, and family drift', async () => {
    const captures = await __test.runRaidCanonicalProbes();
    const read = (overrides = {}, evidence = undefined) => audit(captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })), evidence);
    const leave = captures.find((capture) => capture.name === 'raid-participant-leave');
    const loadout = captures.find((capture) => capture.name === 'raid-loadout-slot-update');
    assert.equal(reason(read({ 'raid-participant-leave': { request: { ...leave.request, method: 'PUT' } } }), 'raid.participant.leave'), 'path_schema_mismatch');
    assert.equal(reason(read({ 'raid-participant-remove': { request: { method: 'POST', url: '/raids/example/participants/remove', body: {} } } }), 'raid.participant.remove'), 'body_mode_or_schema_mismatch');
    assert.equal(reason(read({ 'raid-loadout-slot-update': { request: { ...loadout.request, url: loadout.request.url.replace(/\/loadout\/[^/]+$/, '/loadout') } } }), 'raid.loadout.slot.update'), 'path_schema_mismatch');
    assert.equal(reason(read({ 'raid-finalization-start': { payload: { ok: true } } }), 'raid.finalization.start'), 'real_response_schema_mismatch');
    const evidence = buildCriticalContractEvidence(canonicalRuntimeDescriptors(), isCriticalPublicDescriptor)
        .filter((entry) => IDS.includes(entry.descriptorId))
        .map((entry) => entry.descriptorId === 'raid.cancel' ? { ...entry, familyId: 'wrong-raid-family' } : entry);
    assert.equal(reason(read({}, evidence), 'raid.cancel'), 'family_or_contract_misclassified');
});
