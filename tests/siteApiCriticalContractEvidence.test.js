'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { canonicalRuntimeDescriptors } = require('../helpers/clover/routeSourceAudit');
const { auditCriticalContractEvidence, buildCriticalContractEvidence } = require('../helpers/clover/siteApiCriticalContractEvidence');
const { isCriticalPublicDescriptor } = require('../helpers/clover/siteApiContractAudit');

test('F7 critical evidence covers every independently critical descriptor with request channels', () => {
    const descriptors = canonicalRuntimeDescriptors();
    const audit = auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor);
    assert.equal(audit.total, descriptors.filter(isCriticalPublicDescriptor).length);
    assert.equal(audit.evidenced, audit.total);
    assert.deepEqual(audit.unevidenced, []);
    assert.ok(audit.evidence.every((entry) => entry.requestEvidence.path && entry.requestEvidence.body.mode && entry.responseEvidence.captureFamily));
});

test('F7 critical evidence fails closed when one descriptor evidence is absent', () => {
    const descriptors = canonicalRuntimeDescriptors();
    const all = buildCriticalContractEvidence(descriptors, isCriticalPublicDescriptor);
    const audit = auditCriticalContractEvidence(descriptors, isCriticalPublicDescriptor, all.slice(1));
    assert.equal(audit.unevidenced.length, 1);
});
