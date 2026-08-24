'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalRuntimeDescriptors } = require('../helpers/clover/routeSourceAudit');
const { auditPublicContracts, isCriticalPublicDescriptor } = require('../helpers/clover/siteApiContractAudit');
const {
    BASE_CANONICAL_TARGETS,
    RECRUITMENT_CANONICAL_TARGETS,
    SQUAD_CANONICAL_TARGETS,
    auditCriticalContractEvidence,
    buildCriticalContractEvidence,
} = require('../helpers/clover/siteApiCriticalContractEvidence');
const { __test } = require('../helpers/clover/siteApiHandlerBoundaryProbes');

const IDS = Object.freeze([
    ...Object.keys(SQUAD_CANONICAL_TARGETS),
    ...Object.keys(RECRUITMENT_CANONICAL_TARGETS),
    ...Object.keys(BASE_CANONICAL_TARGETS),
]);

function audit(captures, evidence = undefined) {
    const all = canonicalRuntimeDescriptors();
    return auditCriticalContractEvidence(all.filter((descriptor) => IDS.includes(descriptor.id)), isCriticalPublicDescriptor, evidence, {
        captures,
        registry: auditPublicContracts(all).registry,
    });
}

function reason(result, descriptorId) {
    return result.unproven.find((entry) => entry.descriptorId === descriptorId)?.reason;
}

async function captures() {
    // Each real handler fixture uses SQLite-backed queues. Keep the owners
    // isolated in time as well as by database so their captures remain exact.
    const squad = await __test.runSquadCanonicalProbes();
    const recruitment = await __test.runRecruitmentCanonicalProbes();
    const base = await __test.runBaseCanonicalResidualProbes();
    return [...squad, ...recruitment, ...base];
}

test('last F7 residual descriptors cross real handlers and semantic owners on disposable SQLite', async () => {
    const actual = await captures();
    assert.equal(actual.length, IDS.length);
    for (const capture of actual) {
        assert.equal(capture.outcome, 'MATCHED_SUCCESS', `${capture.name}: ${capture.status} ${capture.error || ''}`);
        assert.ok(capture.status >= 200 && capture.status < 300, capture.name);
    }
    assert.deepEqual(audit(actual).proven.sort(), [...IDS].sort());
});

test('last F7 residual evidence rejects Squad body, path, method, response, family and shape drift', async () => {
    const actual = await captures();
    const read = (overrides = {}, evidence = undefined) => audit(actual.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })), evidence);
    const add = actual.find((capture) => capture.name === 'squad-member-add');
    const remove = actual.find((capture) => capture.name === 'squad-member-remove');
    const transfer = actual.find((capture) => capture.name === 'squad-member-transfer');
    const operations = actual.find((capture) => capture.name === 'squad-operations-read');

    assert.equal(reason(read({ 'squad-member-add': { request: { ...add.request, body: {} } } }), 'squad.member.add'), 'body_mode_or_schema_mismatch');
    assert.equal(reason(read({ 'squad-member-remove': { request: { ...remove.request, url: '/squads/f7_aurora/members/not-a-member/transfer' } } }), 'squad.member.remove'), 'path_schema_mismatch');
    assert.equal(reason(read({ 'squad-member-transfer': { request: { ...transfer.request, method: 'GET' } } }), 'squad.member.transfer'), 'path_schema_mismatch');
    assert.equal(reason(read({ 'squad-operations-read': { payload: { ok: true } } }), 'squad.operations.read'), 'real_response_schema_mismatch');

    const wrongFamily = buildCriticalContractEvidence(canonicalRuntimeDescriptors(), isCriticalPublicDescriptor)
        .filter((entry) => IDS.includes(entry.descriptorId))
        .map((entry) => entry.descriptorId === 'squad.member.transfer' ? { ...entry, familyId: 'wrong-squad-family' } : entry);
    assert.equal(reason(read({}, wrongFamily), 'squad.member.transfer'), 'family_or_contract_misclassified');
    assert.equal(reason(read({ 'squad-operations-read': { contractShapeId: operations.contractShapeId.replace('read', 'wrong') } }), 'squad.operations.read'), 'capture_not_correlated');
});

test('Recruitment and Base residual evidence rejects body, method, response, family and shape drift', async () => {
    const actual = await captures();
    const read = (overrides = {}, evidence = undefined) => audit(actual.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })), evidence);
    const purchase = actual.find((capture) => capture.name === 'recruitment-shop-purchase');
    const login = actual.find((capture) => capture.name === 'site-auth-login');
    const referrer = actual.find((capture) => capture.name === 'site-recruitment-referrer');

    assert.equal(reason(read({ 'recruitment-shop-purchase': { request: { ...purchase.request, body: {} } } }), 'recruitment.shop.purchase'), 'body_mode_or_schema_mismatch');
    assert.equal(reason(read({ 'site-auth-login': { request: { ...login.request, method: 'GET' } } }), 'site.routePublic.post.auth.login'), 'path_schema_mismatch');
    assert.equal(reason(read({ 'site-recruitment-referrer': { payload: { ok: true } } }), 'site.routeAuthed.post.recruitment.referrer'), 'real_response_schema_mismatch');

    const wrongFamily = buildCriticalContractEvidence(canonicalRuntimeDescriptors(), isCriticalPublicDescriptor)
        .filter((entry) => IDS.includes(entry.descriptorId))
        .map((entry) => entry.descriptorId === 'site.routeAuthed.post.boxes.key.open' ? { ...entry, familyId: 'wrong-base-family' } : entry);
    assert.equal(reason(read({}, wrongFamily), 'site.routeAuthed.post.boxes.key.open'), 'family_or_contract_misclassified');
    assert.equal(reason(read({ 'site-recruitment-referrer': { contractShapeId: referrer.contractShapeId.replace('referrer', 'wrong') } }), 'site.routeAuthed.post.recruitment.referrer'), 'capture_not_correlated');
});
