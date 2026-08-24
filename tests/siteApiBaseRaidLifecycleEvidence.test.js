'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalRuntimeDescriptors } = require('../helpers/clover/routeSourceAudit');
const { auditPublicContracts, isCriticalPublicDescriptor } = require('../helpers/clover/siteApiContractAudit');
const { auditCriticalContractEvidence } = require('../helpers/clover/siteApiCriticalContractEvidence');
const { __test } = require('../helpers/clover/siteApiHandlerBoundaryProbes');

const IDS = Object.freeze([
    'site.routeAuthed.post.raids.key.join', 'site.routeAuthed.post.raids.key.leave',
    'site.routeAuthed.post.raids.key.hosts', 'site.routeAuthed.post.raids.key.hosts.revoke',
    'site.routeAuthed.post.raids.key.participants.remove', 'site.routeAuthed.put.raids.key.loadout.slot',
    'site.routeAuthed.post.raids.key.start', 'site.routeAuthed.post.raids.key.finalize',
    'site.routeAuthed.post.raids.key.cancel', 'site.routeAuthed.post.raids.key.items.inventoryItemId.wear',
    'site.routeAuthed.post.raids.key.items.inventoryItemId.consume', 'site.routeAuthed.post.raids.key.conditions',
    'site.routeAuthed.post.raids.key.conditions.conditionId.resolve', 'site.routeAuthed.post.raids.key.rewards',
    'site.routeAuthed.post.raids.key.rewards.rewardId.cancel', 'site.routeAuthed.post.raids.key.complete',
]);

function audit(captures) {
    const descriptors = canonicalRuntimeDescriptors();
    const { registry } = auditPublicContracts(descriptors);
    return auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, undefined, { captures, registry });
}

test('site base raid lifecycle reaches real SQLite-backed handlers and semantic owners', async () => {
    const captures = await __test.runBaseRaidLifecycleProbes();
    assert.equal(captures.length, IDS.length);
    for (const capture of captures) {
        assert.equal(capture.outcome, 'MATCHED_SUCCESS', `${capture.name}: ${capture.status} ${capture.error || ''}`);
        assert.ok(capture.status >= 200 && capture.status < 300);
    }
    assert.deepEqual(audit(captures).proven.filter((id) => IDS.includes(id)).sort(), [...IDS].sort());
});

test('site base raid lifecycle evidence rejects method, body, path, response, and family drift', async () => {
    const captures = await __test.runBaseRaidLifecycleProbes();
    const auditWith = (overrides) => audit(captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })));
    const start = captures.find((capture) => capture.name === 'site-raid-start');
    const wear = captures.find((capture) => capture.name === 'site-raid-item-wear');
    assert.equal(auditWith({ 'site-raid-start': { request: { ...start.request, method: 'PUT' } } }).unproven.find((entry) => entry.descriptorId === 'site.routeAuthed.post.raids.key.start').reason, 'path_schema_mismatch');
    assert.equal(auditWith({ 'site-raid-host-add': { request: { method: 'POST', url: '/raids/example/hosts', body: {} } } }).unproven.find((entry) => entry.descriptorId === 'site.routeAuthed.post.raids.key.hosts').reason, 'body_mode_or_schema_mismatch');
    assert.equal(auditWith({ 'site-raid-item-wear': { request: { ...wear.request, url: wear.request.url.replace(/\/items\/[^/]+\/wear$/, '/items/wear') } } }).unproven.find((entry) => entry.descriptorId === 'site.routeAuthed.post.raids.key.items.inventoryItemId.wear').reason, 'path_schema_mismatch');
    assert.equal(auditWith({ 'site-raid-complete': { payload: { ok: true } } }).unproven.find((entry) => entry.descriptorId === 'site.routeAuthed.post.raids.key.complete').reason, 'real_response_schema_mismatch');
    assert.equal(auditWith({ 'site-raid-condition-add': { semanticFamily: 'wrong-family' } }).unproven.find((entry) => entry.descriptorId === 'site.routeAuthed.post.raids.key.conditions').reason, 'capture_not_correlated');
});
