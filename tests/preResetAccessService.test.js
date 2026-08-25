'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    assertPreResetSurfaceAllowed,
    isPreResetLaunchEnabled,
} = require('../helpers/clover/preResetAccessService');
const { createPreResetPolicyRegistry } = require('../helpers/clover/preResetPolicyRegistryService');

function enabledRegistry() {
    return createPreResetPolicyRegistry({ testOnly: true, policies: {
        PRE_RESET_MODE: { status: 'ENABLED', policyVersion: 'test-mode-v1' },
        SESSION_ELIGIBILITY: { status: 'ENABLED', policyVersion: 'test-session-v1', eligibleReleasedSessions: true },
    } });
}

test('PRE_RESET_LAUNCH_ENABLED aceita somente literal true', () => {
    assert.equal(isPreResetLaunchEnabled({}), false);
    for (const value of ['1', 'TRUE', 'True', 'yes', 'on', ' true ']) {
        assert.equal(isPreResetLaunchEnabled({ PRE_RESET_LAUNCH_ENABLED: value }), false, value);
    }
    assert.equal(isPreResetLaunchEnabled({ PRE_RESET_LAUNCH_ENABLED: 'true' }), true);
});

test('surface funcional falha fechada sem flag, mode policy ou eligibility', () => {
    const session = { playerId: 'player-1', released: true };
    assert.throws(() => assertPreResetSurfaceAllowed({ env: {}, policyRegistry: enabledRegistry(), session }), { code: 'prereset_mode_disabled' });
    assert.throws(() => assertPreResetSurfaceAllowed({ env: { PRE_RESET_LAUNCH_ENABLED: 'true' }, policyRegistry: createPreResetPolicyRegistry(), session }), { code: 'policy_not_configured' });
    assert.throws(() => assertPreResetSurfaceAllowed({ env: { PRE_RESET_LAUNCH_ENABLED: 'true' }, policyRegistry: enabledRegistry(), session: { playerId: 'player-1', released: false } }), { code: 'session_ineligible' });
    assert.equal(assertPreResetSurfaceAllowed({ env: { PRE_RESET_LAUNCH_ENABLED: 'true' }, policyRegistry: enabledRegistry(), session }), true);
});
