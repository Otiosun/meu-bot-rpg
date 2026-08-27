'use strict';

const PRE_RESET_BLOCK_NOTICE_COOLDOWN_MS = 15 * 1000;
const MAX_NOTICE_RECORDS = 2000;
const notices = new Map();

function normalizePlayerKey(playerId) {
    return String(playerId || '').trim().toLowerCase() || 'unknown-player';
}

function prune(now) {
    if (notices.size <= MAX_NOTICE_RECORDS) return;
    for (const [key, expiresAt] of notices.entries()) {
        if (expiresAt <= now) notices.delete(key);
    }
    while (notices.size > MAX_NOTICE_RECORDS) {
        const oldest = notices.keys().next().value;
        if (!oldest) break;
        notices.delete(oldest);
    }
}

function shouldSendPreResetBlockNotice(playerId, options = {}) {
    const now = Number(options.now ?? Date.now());
    const cooldownMs = Number(options.cooldownMs ?? PRE_RESET_BLOCK_NOTICE_COOLDOWN_MS);
    const key = normalizePlayerKey(playerId);
    const expiresAt = notices.get(key) || 0;
    if (expiresAt > now) {
        return Object.freeze({ ok: false, retryMs: expiresAt - now });
    }
    notices.delete(key);
    notices.set(key, now + Math.max(0, cooldownMs));
    prune(now);
    return Object.freeze({ ok: true, retryMs: 0 });
}

function resetPreResetBlockNoticeGuardForTests() {
    notices.clear();
}

module.exports = {
    PRE_RESET_BLOCK_NOTICE_COOLDOWN_MS,
    resetPreResetBlockNoticeGuardForTests,
    shouldSendPreResetBlockNotice,
};
