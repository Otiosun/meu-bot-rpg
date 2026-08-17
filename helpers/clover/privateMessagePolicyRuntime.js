'use strict';

const {
    POLICY_CATEGORIES,
    evaluatePrivateMessagePolicy,
} = require('./privateMessagePolicy');

const POLICY_MODES = Object.freeze({
    OFF: 'off',
    OBSERVE: 'observe',
    ENFORCE: 'enforce',
});

function normalizePolicyMode(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return Object.values(POLICY_MODES).includes(normalized)
        ? normalized
        : POLICY_MODES.OFF;
}

function resolvePolicyMode(env = process.env) {
    return normalizePolicyMode(env?.CLOVER_PV_POLICY_MODE);
}

function isPrivateTarget(targetJid) {
    const value = String(targetJid || '').trim().toLowerCase();
    return Boolean(value) && !value.endsWith('@g.us');
}

function evaluateRuntimePrivateMessage(input = {}, env = process.env) {
    const mode = resolvePolicyMode(env);
    const privateTarget = isPrivateTarget(input.targetJid);

    if (!privateTarget) {
        return {
            mode,
            allowed: true,
            wouldAllow: true,
            enforced: false,
            observed: false,
            privateTarget: false,
            reason: 'non_private_target',
            policyDecision: evaluatePrivateMessagePolicy({
                ...input,
                category: POLICY_CATEGORIES.NON_PRIVATE,
            }, env),
        };
    }

    const policyDecision = evaluatePrivateMessagePolicy(input, env);
    const hardBlock = ['private_source_not_allowlisted', 'source_blocked'].includes(policyDecision.reason);

    if (hardBlock) {
        return {
            mode,
            allowed: false,
            wouldAllow: false,
            enforced: true,
            observed: false,
            privateTarget: true,
            reason: policyDecision.reason,
            policyDecision,
        };
    }

    if (mode === POLICY_MODES.OFF) {
        return {
            mode,
            allowed: true,
            wouldAllow: policyDecision.allowed,
            enforced: false,
            observed: false,
            privateTarget: true,
            reason: 'policy_off',
            policyDecision,
        };
    }

    if (mode === POLICY_MODES.OBSERVE) {
        return {
            mode,
            allowed: true,
            wouldAllow: policyDecision.allowed,
            enforced: false,
            observed: true,
            privateTarget: true,
            reason: policyDecision.allowed
                ? 'observed_allowed'
                : 'observed_blocked',
            policyDecision,
        };
    }

    return {
        mode,
        allowed: policyDecision.allowed,
        wouldAllow: policyDecision.allowed,
        enforced: true,
        observed: false,
        privateTarget: true,
        reason: policyDecision.reason,
        policyDecision,
    };
}

function buildPolicySkipResult(runtimeDecision) {
    if (!runtimeDecision || runtimeDecision.allowed) return null;

    return {
        skipped: true,
        reason: 'pv_policy_blocked',
        policy: {
            mode: runtimeDecision.mode,
            source: runtimeDecision.policyDecision?.policy?.source || null,
            category: runtimeDecision.policyDecision?.policy?.category || null,
            disposition: runtimeDecision.policyDecision?.policy?.disposition || null,
            decisionReason: runtimeDecision.policyDecision?.reason || runtimeDecision.reason,
        },
    };
}

module.exports = {
    POLICY_MODES,
    buildPolicySkipResult,
    evaluateRuntimePrivateMessage,
    isPrivateTarget,
    normalizePolicyMode,
    resolvePolicyMode,
};
