'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalRuntimeDescriptors } = require('../helpers/clover/routeSourceAudit');
const { auditPublicContracts, isCriticalPublicDescriptor } = require('../helpers/clover/siteApiContractAudit');
const { auditCriticalContractEvidence } = require('../helpers/clover/siteApiCriticalContractEvidence');
const { __test } = require('../helpers/clover/siteApiHandlerBoundaryProbes');

function audit(captures) {
    const all = canonicalRuntimeDescriptors();
    return auditCriticalContractEvidence(all.filter((item) => item.id === 'skill.tree.purchase'), isCriticalPublicDescriptor, undefined, { captures, registry: auditPublicContracts(all).registry });
}
test('skill tree purchase uses a real site session and the live purchase service on disposable SQLite', async () => {
    const captures = await __test.runSkillTreePurchaseProbe();
    assert.equal(captures[0].status, 200);
    assert.equal(captures[0].payload.ok, true);
    assert.ok(captures[0].payload.purchase);
    assert.deepEqual(audit(captures).proven, ['skill.tree.purchase']);
});
test('skill tree purchase rejects body, method and response drift', async () => {
    const [capture] = await __test.runSkillTreePurchaseProbe();
    assert.equal(audit([{ ...capture, request: { ...capture.request, body: {} } }]).unproven[0].reason, 'body_mode_or_schema_mismatch');
    assert.equal(audit([{ ...capture, request: { ...capture.request, method: 'GET' } }]).unproven[0].reason, 'path_schema_mismatch');
    assert.equal(audit([{ ...capture, payload: { ok: true } }]).unproven[0].reason, 'real_response_schema_mismatch');
});
