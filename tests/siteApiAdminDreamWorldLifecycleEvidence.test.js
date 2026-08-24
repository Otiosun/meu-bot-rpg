'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { canonicalRuntimeDescriptors } = require('../helpers/clover/routeSourceAudit');
const { auditCriticalContractEvidence, buildCriticalContractEvidence } = require('../helpers/clover/siteApiCriticalContractEvidence');
const { auditPublicContracts, isCriticalPublicDescriptor } = require('../helpers/clover/siteApiContractAudit');
const { __test } = require('../helpers/clover/siteApiHandlerBoundaryProbes');

const ADMIN_LIFECYCLE_IDS = Object.freeze([
    'admin.dream-worlds.requests',
    'admin.dream-worlds.applications',
    'admin.dream-worlds.application.review',
    'admin.dream-worlds.application.select',
    'admin.dream-worlds.application.reject',
    'admin.dream-worlds.request.approve',
    'admin.dream-worlds.request.reject',
    'admin.dream-worlds.runs.list',
    'admin.dream-worlds.runs.detail',
    'admin.dream-worlds.slot.invite',
    'admin.dream-worlds.slot.confirm',
    'admin.dream-worlds.slot.remove',
    'admin.dream-worlds.slot.replace',
    'admin.dream-worlds.run.start',
    'admin.dream-worlds.run.advance',
    'admin.dream-worlds.run.pause',
    'admin.dream-worlds.run.resume',
    'admin.dream-worlds.run.complete',
    'admin.dream-worlds.run.fail',
    'admin.dream-worlds.run.cancel',
]);

async function auditLifecycle(overrides = {}, evidence) {
    const descriptors = canonicalRuntimeDescriptors();
    const captures = await __test.runAdminDreamWorldLifecycleProbes();
    return auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, evidence, {
        captures: captures.map((capture) => ({ ...capture, ...(overrides[capture.name] || {}) })),
        registry: auditPublicContracts(descriptors).registry,
    });
}

test('F7 Dream Worlds admin lifecycle captures all twenty real disposable-SQLite operations', async () => {
    const audit = await auditLifecycle();
    assert.deepEqual(audit.proven.filter((id) => ADMIN_LIFECYCLE_IDS.includes(id)), ADMIN_LIFECYCLE_IDS);
});

test('F7 Dream Worlds admin lifecycle rejects path, body, response and family drift', async () => {
    const reason = (audit, id) => audit.unproven.find((entry) => entry.descriptorId === id)?.reason;
    assert.equal(reason(await auditLifecycle({
        'admin-dream-slot-replace': { request: { method: 'POST', url: '/admin/dream-worlds/runs/1/slots/1/confirm', body: { playerId: 'fixture-dream-replacement@lid', mode: 'confirmed' } } },
    }), 'admin.dream-worlds.slot.replace'), 'path_schema_mismatch');
    assert.equal(reason(await auditLifecycle({
        'admin-dream-run-advance': { request: { method: 'POST', url: '/admin/dream-worlds/runs/1/advance', body: { chapter: '2' } } },
    }), 'admin.dream-worlds.run.advance'), 'body_mode_or_schema_mismatch');
    assert.equal(reason(await auditLifecycle({
        'admin-dream-request-approve': { payload: { ok: true, duplicate: false, request: {}, run: 'broad-ack' } },
    }), 'admin.dream-worlds.request.approve'), 'real_response_schema_mismatch');
    const descriptors = canonicalRuntimeDescriptors();
    const evidence = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor).map((entry) => entry.descriptorId === 'admin.dream-worlds.run.cancel' ? { ...entry, familyId: 'wrong-dream-family' } : entry);
    assert.equal(reason(await auditLifecycle({}, evidence), 'admin.dream-worlds.run.cancel'), 'family_or_contract_misclassified');
});
