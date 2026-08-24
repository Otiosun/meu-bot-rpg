'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { canonicalRuntimeDescriptors } = require('../helpers/clover/routeSourceAudit');
const { auditCriticalContractEvidence, buildCriticalContractEvidence } = require('../helpers/clover/siteApiCriticalContractEvidence');
const { auditPublicContracts, isCriticalPublicDescriptor } = require('../helpers/clover/siteApiContractAudit');
const { __test } = require('../helpers/clover/siteApiHandlerBoundaryProbes');

async function adminApprovalAudit(overrides = {}, evidence = undefined) {
    const descriptors = canonicalRuntimeDescriptors();
    const captures = await __test.runAdminSkillApprovalAndRaidReviewProbes();
    return auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, evidence, {
        captures: captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })),
        registry: auditPublicContracts(descriptors).registry,
    });
}

test('F7 Admin skill approvals and raid reward review reach real SQLite-backed semantic owners', async () => {
    const audit = await adminApprovalAudit();
    assert.deepEqual(audit.proven.filter((id) => id.startsWith('admin.skill-approvals') || id === 'admin.raid-reward-proposals.list'), [
        'admin.raid-reward-proposals.list',
        'admin.skill-approvals.list',
        'admin.skill-approvals.approve',
        'admin.skill-approvals.reject',
    ]);
});

test('F7 Admin skill approval evidence rejects body, path, response, family and method drift', async () => {
    const reason = (audit, id) => audit.unproven.find((entry) => entry.descriptorId === id)?.reason;
    assert.equal(reason(await adminApprovalAudit({
        'admin-skill-approvals-list': { request: { method: 'GET', url: '/admin/skill-approvals?status=pending', body: {} } },
    }), 'admin.skill-approvals.list'), 'body_mode_or_schema_mismatch');
    assert.equal(reason(await adminApprovalAudit({
        'admin-skill-approval-approve': { request: { method: 'POST', url: '/admin/skill-approvals/SA-EXAMPLE/reject', body: { reason: 'x' } } },
    }), 'admin.skill-approvals.approve'), 'path_schema_mismatch');
    assert.equal(reason(await adminApprovalAudit({
        'admin-skill-approval-reject': { payload: { ok: true, request: {} } },
    }), 'admin.skill-approvals.reject'), 'real_response_schema_mismatch');
    assert.equal(reason(await adminApprovalAudit({
        'admin-raid-reward-proposals-list': { request: { method: 'POST', url: '/admin/raid-reward-proposals', body: null } },
    }), 'admin.raid-reward-proposals.list'), 'path_schema_mismatch');
    const descriptors = canonicalRuntimeDescriptors();
    const evidence = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor).map((entry) => entry.descriptorId === 'admin.skill-approvals.reject'
        ? { ...entry, familyId: 'wrong-admin-skill-approval-family' }
        : entry);
    assert.equal(reason(await adminApprovalAudit({}, evidence), 'admin.skill-approvals.reject'), 'family_or_contract_misclassified');
});
