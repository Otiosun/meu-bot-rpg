'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalRuntimeDescriptors } = require('../helpers/clover/routeSourceAudit');
const { auditPublicContracts, isCriticalPublicDescriptor } = require('../helpers/clover/siteApiContractAudit');
const { auditCriticalContractEvidence } = require('../helpers/clover/siteApiCriticalContractEvidence');
const { __test } = require('../helpers/clover/siteApiHandlerBoundaryProbes');

const IDS = Object.freeze([
    'site.routeAuthed.post.auth.logout',
    'site.routeAuthed.put.character.profile-image',
    'site.routeAuthed.post.hexagono',
    'site.routeAuthed.post.hexagon',
    'site.routeAuthed.put.attributes',
]);

test('site base session/progression captures execute the real handler and services on disposable SQLite', async () => {
    const captures = await __test.runBaseSessionProgressionProbes();
    assert.equal(captures.length, IDS.length);
    for (const capture of captures) {
        assert.equal(capture.outcome, 'MATCHED_SUCCESS', `${capture.name}: ${capture.status} ${capture.error || ''}`);
        assert.ok(capture.status >= 200 && capture.status < 300);
    }
    const descriptors = canonicalRuntimeDescriptors();
    const { registry } = auditPublicContracts(descriptors);
    const audit = auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, undefined, { captures, registry });
    assert.deepEqual(audit.proven.filter((id) => IDS.includes(id)).sort(), [...IDS].sort());
});

test('site base session/progression evidence rejects body, path, response, and family corruption', async () => {
    const captures = await __test.runBaseSessionProgressionProbes();
    const descriptors = canonicalRuntimeDescriptors();
    const { registry } = auditPublicContracts(descriptors);
    const auditWith = (overrides) => auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, undefined, {
        captures: captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })),
        registry,
    });
    assert.equal(auditWith({ 'site-character-profile-image': { request: { method: 'PUT', url: '/character/profile-image', body: {} } } }).unproven.find((entry) => entry.descriptorId === 'site.routeAuthed.put.character.profile-image').reason, 'body_mode_or_schema_mismatch');
    assert.equal(auditWith({ 'site-attributes-update': { request: { method: 'PUT', url: '/attribute', body: { forca: 1, velocidade: 1, agilidade: 1, resistencia: 1, poder_magico: 1 } } } }).unproven.find((entry) => entry.descriptorId === 'site.routeAuthed.put.attributes').reason, 'path_schema_mismatch');
    assert.equal(auditWith({ 'site-hexagono-upgrade': { payload: { ok: true } } }).unproven.find((entry) => entry.descriptorId === 'site.routeAuthed.post.hexagono').reason, 'real_response_schema_mismatch');
    assert.equal(auditWith({ 'site-auth-logout': { semanticFamily: 'wrong-family' } }).unproven.find((entry) => entry.descriptorId === 'site.routeAuthed.post.auth.logout').reason, 'capture_not_correlated');
});
