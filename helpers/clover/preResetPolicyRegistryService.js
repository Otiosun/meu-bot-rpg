'use strict';

// This registry is deliberately in-memory until product approves a persistent
// configuration authority.  Production receives this default-only registry;
// tests may opt in to a separately marked synthetic policy.
const POLICY_KEYS = Object.freeze([
    'PRE_RESET_MODE',
    'PH_RETURN_CONVERSION',
    'RESET_SHOP',
    'LIMITED_CHOICES',
    'REFUND',
    'SESSION_ELIGIBILITY',
]);

const POLICY_STATUSES = Object.freeze(['NOT_CONFIGURED', 'DISABLED', 'ENABLED']);

class PreResetPolicyError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PreResetPolicyError';
        this.code = code;
        this.details = details;
    }
}

function policyKey(value) {
    const key = String(value || '').trim().toUpperCase();
    if (!POLICY_KEYS.includes(key)) {
        throw new PreResetPolicyError('unknown_policy', 'Politica pre-reset desconhecida.');
    }
    return key;
}

function version(value, label = 'policyVersion') {
    const clean = String(value || '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(clean)) {
        throw new PreResetPolicyError('invalid_policy', `${label} invalida.`);
    }
    return clean;
}

function defaultPolicy(key) {
    return Object.freeze({
        key,
        status: 'NOT_CONFIGURED',
        enabled: false,
        policyVersion: null,
        testOnly: false,
        reason: 'A politica de produto ainda nao foi configurada.',
    });
}

function validateEnabledPolicy(key, input, testOnly) {
    if (!testOnly) {
        throw new PreResetPolicyError('production_policy_configuration_forbidden', 'Configuracao pre-reset de producao ainda nao esta autorizada.');
    }
    const base = {
        key,
        status: 'ENABLED',
        enabled: true,
        policyVersion: version(input.policyVersion),
        testOnly: true,
        reason: 'Fixture sintetica TEST-ONLY.',
    };
    if (key === 'PH_RETURN_CONVERSION') {
        const resetCycleKey = version(input.resetCycleKey, 'resetCycleKey');
        const numerator = Number(input.rate?.numerator);
        const denominator = Number(input.rate?.denominator);
        if (!Number.isInteger(numerator) || numerator < 0 || !Number.isInteger(denominator) || denominator <= 0
            || !['floor', 'ceil'].includes(input.rounding) || input.phConsumption !== 'none'
            || !String(input.cutoff || '').trim()) {
            throw new PreResetPolicyError('invalid_policy', 'Politica sintetica de conversao incompleta.');
        }
        return Object.freeze({ ...base, resetCycleKey, cutoff: String(input.cutoff), rate: Object.freeze({ numerator, denominator }), rounding: input.rounding, phConsumption: 'none' });
    }
    if (key === 'RESET_SHOP') {
        if (!Array.isArray(input.catalogVersion ? input.products : null)) {
            throw new PreResetPolicyError('invalid_policy', 'Catalogo sintetico incompleto.');
        }
        return Object.freeze({ ...base, catalogVersion: version(input.catalogVersion, 'catalogVersion'), products: Object.freeze(input.products.map((item) => Object.freeze({ ...item }))) });
    }
    if (key === 'SESSION_ELIGIBILITY') {
        if (input.eligibleReleasedSessions !== true) {
            throw new PreResetPolicyError('invalid_policy', 'Eligibility sintetica incompleta.');
        }
        return Object.freeze({ ...base, eligibleReleasedSessions: true });
    }
    return Object.freeze(base);
}

function normalizePolicy(key, input, testOnly) {
    if (!input) return defaultPolicy(key);
    const status = String(input.status || '').trim().toUpperCase();
    if (!POLICY_STATUSES.includes(status)) {
        throw new PreResetPolicyError('invalid_policy', 'Estado de politica invalido.');
    }
    if (status !== 'ENABLED') {
        return Object.freeze({ ...defaultPolicy(key), status, reason: String(input.reason || 'Politica desativada.') });
    }
    return validateEnabledPolicy(key, input, testOnly);
}

function createPreResetPolicyRegistry(options = {}) {
    const testOnly = options.testOnly === true;
    const supplied = options.policies && typeof options.policies === 'object' ? options.policies : {};
    const policies = new Map(POLICY_KEYS.map((key) => [key, normalizePolicy(key, supplied[key], testOnly)]));
    return Object.freeze({
        testOnly,
        get(key) { return policies.get(policyKey(key)); },
        snapshot() { return Object.freeze(Object.fromEntries(POLICY_KEYS.map((key) => [key, policies.get(key)]))); },
    });
}

const DEFAULT_PRE_RESET_POLICY_REGISTRY = createPreResetPolicyRegistry();

function requireEnabledPolicy(registry, key) {
    const policy = (registry || DEFAULT_PRE_RESET_POLICY_REGISTRY).get(policyKey(key));
    if (!policy || policy.status === 'NOT_CONFIGURED') {
        throw new PreResetPolicyError('policy_not_configured', 'A politica necessaria ainda nao foi configurada.');
    }
    if (policy.enabled !== true) {
        throw new PreResetPolicyError('policy_disabled', 'A politica necessaria esta desativada.');
    }
    return policy;
}

function evaluateSessionEligibility(registry, session = {}) {
    const policy = requireEnabledPolicy(registry, 'SESSION_ELIGIBILITY');
    if (policy.eligibleReleasedSessions !== true || session.released !== true || !String(session.playerId || '').trim()) {
        throw new PreResetPolicyError('session_ineligible', 'A sessao nao esta elegivel para preparacao pre-reset.');
    }
    return policy;
}

module.exports = {
    DEFAULT_PRE_RESET_POLICY_REGISTRY,
    POLICY_KEYS,
    POLICY_STATUSES,
    PreResetPolicyError,
    createPreResetPolicyRegistry,
    evaluateSessionEligibility,
    requireEnabledPolicy,
};
