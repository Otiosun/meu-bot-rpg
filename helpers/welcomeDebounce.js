const DEFAULT_WELCOME_DEBOUNCE_MS = 3 * 60 * 1000;

const recentWelcomes = new Map();

function buildWelcomeKey(groupId, playerId) {
    return `${String(groupId || '').trim()}::${String(playerId || '').trim()}`;
}

function clearExpiredWelcomeDebounces(now = Date.now()) {
    for (const [key, expiresAt] of recentWelcomes.entries()) {
        if (expiresAt <= now) recentWelcomes.delete(key);
    }
}

function shouldSendWelcome(groupId, playerId, options = {}) {
    const now = options.now || Date.now();
    const ttlMs = options.ttlMs || DEFAULT_WELCOME_DEBOUNCE_MS;
    const key = buildWelcomeKey(groupId, playerId);
    if (!key || key === '::') return false;

    clearExpiredWelcomeDebounces(now);
    if (recentWelcomes.has(key)) return false;

    recentWelcomes.set(key, now + ttlMs);
    return true;
}

function clearWelcomeDebounce(groupId, playerId) {
    recentWelcomes.delete(buildWelcomeKey(groupId, playerId));
}

module.exports = {
    DEFAULT_WELCOME_DEBOUNCE_MS,
    clearWelcomeDebounce,
    shouldSendWelcome,
};
