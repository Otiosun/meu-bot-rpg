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

function enabledEnv(overrides = {}) {
    return {
        PRE_RESET_LAUNCH_ENABLED: 'true',
        PRE_RESET_RETURN_ENABLED: 'true',
        ...overrides,
    };
}

function ownerApprovedRuntimeEnv(overrides = {}) {
    return enabledEnv({
        PRE_RESET_RUNTIME_POLICY_ENABLED: 'true',
        PRE_RESET_POLICY_APPROVED_BY: 'owner',
        PRE_RESET_POLICY_APPROVAL_ID: 'owner-open-prereset-20260828-v1',
        PRE_RESET_POLICY_APPROVED_AT: '2026-08-28T18:40:00.000Z',
        PRE_RESET_POLICY_VERSION: 'prereset-open-20260828-v1',
        PRE_RESET_SESSION_POLICY_VERSION: 'prereset-session-20260828-v1',
        PRE_RESET: 'OFF',
        ...overrides,
    });
}

test('gate PRE_RESET exige os dois literais true', () => {
    assert.equal(isPreResetLaunchEnabled({}), false);
    assert.equal(isPreResetLaunchEnabled({ PRE_RESET_LAUNCH_ENABLED:'true' }), false);
    assert.equal(isPreResetLaunchEnabled({ PRE_RESET_RETURN_ENABLED:'true' }), false);
    assert.equal(isPreResetLaunchEnabled({ PRE_RESET_LAUNCH_ENABLED:'TRUE', PRE_RESET_RETURN_ENABLED:'true' }), false);
    assert.equal(isPreResetLaunchEnabled(enabledEnv()), true);
});

test('surface funcional falha fechada sem flag, mode policy ou eligibility', () => {
    const session = { playerId: 'player-1', released: true };
    assert.throws(() => assertPreResetSurfaceAllowed({ env: {}, policyRegistry: enabledRegistry(), session }), { code: 'prereset_mode_disabled' });
    assert.throws(() => assertPreResetSurfaceAllowed({ env: enabledEnv(), policyRegistry: createPreResetPolicyRegistry(), session }), { code: 'policy_not_configured' });
    assert.throws(() => assertPreResetSurfaceAllowed({ env: enabledEnv(), policyRegistry: enabledRegistry(), session: { playerId: 'player-1', released: false } }), { code: 'session_ineligible' });
    assert.equal(assertPreResetSurfaceAllowed({ env: enabledEnv(), policyRegistry: enabledRegistry(), session }), true);
});

test('runtime de producao abre PRE_RESET somente com aprovacao explicita do owner e sem PRE_RESET destrutivo', () => {
    const session = { playerId:'player-1', released:true };
    const env = ownerApprovedRuntimeEnv();
    assert.equal(env.PRE_RESET, 'OFF');
    assert.equal(assertPreResetSurfaceAllowed({ env, session }), true);
});

test('runtime de producao falha fechado se aprovacao owner estiver incompleta ou invalida', () => {
    const session = { playerId:'player-1', released:true };
    assert.throws(
        () => assertPreResetSurfaceAllowed({ env:ownerApprovedRuntimeEnv({ PRE_RESET_POLICY_APPROVAL_ID:'' }), session }),
        { code:'invalid_production_approval' }
    );
    assert.throws(
        () => assertPreResetSurfaceAllowed({ env:ownerApprovedRuntimeEnv({ PRE_RESET_POLICY_APPROVED_BY:'admin' }), session }),
        { code:'invalid_production_approval' }
    );
});

test('flags de abertura sem runtime policy aprovado continuam bloqueadas', () => {
    const session = { playerId:'player-1', released:true };
    assert.throws(
        () => assertPreResetSurfaceAllowed({ env:enabledEnv(), session }),
        { code:'policy_not_configured' }
    );
});
