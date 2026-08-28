'use strict';

const {
    DEFAULT_PRE_RESET_POLICY_REGISTRY,
    PreResetPolicyError,
    evaluateSessionEligibility,
    requireEnabledPolicy,
} = require('./preResetPolicyRegistryService');

class PreResetAccessError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'PreResetAccessError';
        this.code = code;
    }
}

function isPreResetLaunchEnabled(env = process.env) {
    // Bot e site compartilham o mesmo gate. Somente os dois literais true
    // habilitam qualquer superficie PRE_RESET; estados parciais falham fechado.
    return env?.PRE_RESET_LAUNCH_ENABLED === 'true'
        && env?.PRE_RESET_RETURN_ENABLED === 'true';
}

function assertPreResetSurfaceAllowed(context = {}) {
    if (!isPreResetLaunchEnabled(context.env || process.env)) {
        throw new PreResetAccessError('prereset_mode_disabled', 'O modo pre-reset esta desativado.');
    }
    const registry = context.policyRegistry || DEFAULT_PRE_RESET_POLICY_REGISTRY;
    try {
        requireEnabledPolicy(registry, 'PRE_RESET_MODE');
        if (context.session) evaluateSessionEligibility(registry, context.session);
    } catch (error) {
        if (error instanceof PreResetPolicyError) {
            throw new PreResetAccessError(error.code, error.message);
        }
        throw error;
    }
    return true;
}

function assertPreResetMutationAllowed(context = {}) {
    assertPreResetSurfaceAllowed(context);
    const sessionPlayerId = String(context.session?.playerId || '').trim();
    const targetPlayerId = String(context.playerId || '').trim();
    if (!sessionPlayerId || !targetPlayerId || sessionPlayerId !== targetPlayerId) {
        throw new PreResetAccessError('ownership_denied', 'A sessao nao pode alterar esse personagem futuro.');
    }
    return { playerId: targetPlayerId };
}

function assertPreResetAdminMutationAllowed(context = {}) {
    assertPreResetSurfaceAllowed({
        env: context.env,
        policyRegistry: context.policyRegistry,
    });
    return true;
}

function assertPreResetAdminCapability(access = {}, capability) {
    const required = String(capability || '').trim();
    const capabilities = new Set(Array.isArray(access.capabilities) ? access.capabilities : []);
    if (!required || !capabilities.has(required)) {
        throw new PreResetAccessError('capability_denied', 'Capacidade administrativa insuficiente.');
    }
    return true;
}

module.exports = {
    PreResetAccessError,
    assertPreResetAdminCapability,
    assertPreResetAdminMutationAllowed,
    assertPreResetMutationAllowed,
    assertPreResetSurfaceAllowed,
    isPreResetLaunchEnabled,
};
