const { COMMAND_PREFIX } = require('../config/bot');
const { normalizeCommandText, normalizeText } = require('./textUtils');

const COMMON_COOLDOWN_MS = 1800;
const HEAVY_COOLDOWN_MS = 3500;

const cooldowns = new Map();
const activeLocks = new Set();

const HEAVY_COMMANDS = new Set([
    `${COMMAND_PREFIX}sortear`,
    `${COMMAND_PREFIX}magia`,
    `${COMMAND_PREFIX}magias`,
    `${COMMAND_PREFIX}confirmar`,
    `${COMMAND_PREFIX}confirmarficha`,
    `${COMMAND_PREFIX}cancelar`,
    `${COMMAND_PREFIX}cancelarficha`,
]);

const CRITICAL_COMMANDS = new Set([
    `${COMMAND_PREFIX}sortear`,
    `${COMMAND_PREFIX}confirmar`,
    `${COMMAND_PREFIX}confirmarficha`,
    `${COMMAND_PREFIX}cancelar`,
    `${COMMAND_PREFIX}cancelarficha`,
]);

function normalizeCommand(value) {
    return normalizeCommandText(value);
}

function normalizePlayerKey(playerId) {
    return String(playerId || '').trim() || 'unknown-player';
}

function isTraitAttempt(commandName, body) {
    return normalizeCommand(commandName) === `${COMMAND_PREFIX}tracos`
        && normalizeText(body).startsWith('tentar ');
}

function isMagicConfirmation(commandName, body) {
    if (![`${COMMAND_PREFIX}magia`, `${COMMAND_PREFIX}magias`].includes(normalizeCommand(commandName))) {
        return false;
    }

    return ['confirmar', 'confirmo', 'sim', 'cancelar', 'cancela', 'nao', 'não'].includes(normalizeText(body));
}

function getCommandCooldownMs(commandName, body = '') {
    const normalizedCommand = normalizeCommand(commandName);
    if (HEAVY_COMMANDS.has(normalizedCommand) || isTraitAttempt(normalizedCommand, body)) {
        return HEAVY_COOLDOWN_MS;
    }
    return COMMON_COOLDOWN_MS;
}

function checkCommandCooldown(playerId, commandName, body = '', options = {}) {
    const now = options.now || Date.now();
    const playerKey = normalizePlayerKey(playerId);
    const current = cooldowns.get(playerKey);

    if (current && current.expiresAt > now) {
        return {
            ok: false,
            retryMs: current.expiresAt - now,
        };
    }

    cooldowns.set(playerKey, {
        expiresAt: now + getCommandCooldownMs(commandName, body),
    });

    return { ok: true, retryMs: 0 };
}

function getCriticalLockKey(playerId, commandName, body = '') {
    const normalizedCommand = normalizeCommand(commandName);
    const playerKey = normalizePlayerKey(playerId);

    if (CRITICAL_COMMANDS.has(normalizedCommand)) {
        return `${playerKey}:${normalizedCommand}`;
    }

    if (isTraitAttempt(normalizedCommand, body)) {
        return `${playerKey}:${COMMAND_PREFIX}tracos:tentar`;
    }

    if (isMagicConfirmation(normalizedCommand, body)) {
        return `${playerKey}:${COMMAND_PREFIX}magias:confirmar`;
    }

    return null;
}

async function runWithCommandLock(lockKey, fn) {
    if (!lockKey) {
        return { locked: false, result: await fn() };
    }

    if (activeLocks.has(lockKey)) {
        return { locked: true, result: null };
    }

    activeLocks.add(lockKey);
    try {
        return { locked: false, result: await fn() };
    } finally {
        activeLocks.delete(lockKey);
    }
}

function renderCooldownMessage(retryMs) {
    const seconds = Math.max(1, Math.ceil(Number(retryMs || 0) / 1000));
    return `Aguarde ${seconds}s e tente de novo.`;
}

function renderLockedMessage() {
    return 'Esse comando ja esta sendo processado para voce. Aguarde a resposta atual.';
}

module.exports = {
    COMMON_COOLDOWN_MS,
    HEAVY_COOLDOWN_MS,
    checkCommandCooldown,
    getCriticalLockKey,
    renderCooldownMessage,
    renderLockedMessage,
    runWithCommandLock,
};
