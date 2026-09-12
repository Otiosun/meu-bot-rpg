'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    PreResetPolicyError,
    createPreResetPolicyRegistry,
    requireEnabledPolicy,
} = require('../helpers/clover/preResetPolicyRegistryService');

test('production policy remains fail-closed without explicit owner approval', () => {
    assert.throws(
        () => createPreResetPolicyRegistry({
            policies: {
                PRE_RESET_MODE: {
                    status: 'ENABLED',
                    policyVersion: 'prereset-owner-approved-v1',
                },
            },
        }),
        (error) => error instanceof PreResetPolicyError
            && error.code === 'production_policy_configuration_forbidden'
    );
});

test('explicit owner approval enables a production registry without testOnly', () => {
    const registry = createPreResetPolicyRegistry({
        productionApproval: {
            approvedBy: 'owner',
            approvalId: 'owner-prpv-20260828-1502',
            approvedAt: '2026-08-28T18:02:00.000Z',
        },
        policies: {
            PRE_RESET_MODE: {
                status: 'ENABLED',
                policyVersion: 'prereset-owner-approved-v1',
            },
            SESSION_ELIGIBILITY: {
                status: 'ENABLED',
                policyVersion: 'prereset-session-owner-approved-v1',
                eligibleReleasedSessions: true,
            },
        },
    });

    assert.equal(registry.testOnly, false);
    assert.equal(registry.productionApproved, true);
    assert.equal(registry.productionApproval.approvedBy, 'owner');
    assert.equal(registry.productionApproval.approvalId, 'owner-prpv-20260828-1502');

    const mode = requireEnabledPolicy(registry, 'PRE_RESET_MODE');
    assert.equal(mode.enabled, true);
    assert.equal(mode.testOnly, false);
    assert.equal(mode.productionApproved, true);
    assert.equal(mode.approvalId, 'owner-prpv-20260828-1502');

    const session = requireEnabledPolicy(registry, 'SESSION_ELIGIBILITY');
    assert.equal(session.eligibleReleasedSessions, true);
    assert.equal(session.productionApproved, true);
});

test('malformed production approval is rejected', () => {
    assert.throws(
        () => createPreResetPolicyRegistry({
            productionApproval: {
                approvedBy: 'admin',
                approvalId: 'owner-prpv-20260828-1502',
                approvedAt: '2026-08-28T18:02:00.000Z',
            },
            policies: {},
        }),
        (error) => error instanceof PreResetPolicyError
            && error.code === 'invalid_production_approval'
    );
});
