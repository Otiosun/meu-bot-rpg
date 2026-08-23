'use strict';

class PreResetAccessError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'PreResetAccessError';
        this.code = code;
    }
}

function isPreResetLaunchEnabled(env = process.env) {
    // Only the explicit literal true enables the future route surface. Missing,
    // malformed and truthy-looking values fail closed.
    return env?.PRE_RESET_LAUNCH_ENABLED === 'true';
}

function assertPreResetMutationAllowed(context = {}) {
    if (!isPreResetLaunchEnabled(context.env || process.env)) {
        throw new PreResetAccessError('prereset_mode_disabled', 'O modo pre-reset esta desativado.');
    }
    const sessionPlayerId = String(context.session?.playerId || '').trim();
    const targetPlayerId = String(context.playerId || '').trim();
    if (!sessionPlayerId || !targetPlayerId || sessionPlayerId !== targetPlayerId) {
        throw new PreResetAccessError('ownership_denied', 'A sessao nao pode alterar esse personagem futuro.');
    }
    return { playerId: targetPlayerId };
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
    assertPreResetMutationAllowed,
    isPreResetLaunchEnabled,
};
