'use strict';

const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_LIMIT = 10;

function buildQuestionId({ idChat, messageId }) {
    const source = `${String(idChat || '')}|${String(messageId || '')}`;
    return `wa_${crypto.createHash('sha256').update(source).digest('hex').slice(0, 24)}`;
}

function envFlag(value) {
    return ['1', 'true', 'yes', 'on', 'sim'].includes(String(value || '').trim().toLowerCase());
}

function normalizeEndpoint(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    let url;
    try {
        url = new URL(raw);
    } catch {
        return '';
    }
    if (url.protocol !== 'https:') return '';
    return url.toString().replace(/\/$/, '');
}

function buildAgentBridgeConfig(env = process.env) {
    const enabled = envFlag(env.CLOVER_AGENT_BRIDGE_ENABLED);
    const endpoint = normalizeEndpoint(env.CLOVER_AGENT_BRIDGE_URL);
    const secret = String(env.CLOVER_AGENT_BRIDGE_SECRET || '').trim();
    const timeoutMs = Number.parseInt(env.CLOVER_AGENT_BRIDGE_TIMEOUT_MS || '', 10);
    const pollMs = Number.parseInt(env.CLOVER_AGENT_BRIDGE_POLL_MS || '', 10);

    return {
        enabled,
        endpoint,
        secret,
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1000 ? timeoutMs : DEFAULT_TIMEOUT_MS,
        pollMs: Number.isFinite(pollMs) && pollMs >= 3000 ? pollMs : 8000,
        valid: !enabled || Boolean(endpoint && secret),
    };
}

function createTimeoutSignal(timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    return {
        signal: controller.signal,
        clear: () => clearTimeout(timer),
    };
}

async function parseJsonResponse(response) {
    const text = await response.text();
    let payload;
    try {
        payload = text ? JSON.parse(text) : {};
    } catch {
        const error = new Error('Resposta inválida do Clover Agent Bridge.');
        error.code = 'invalid_bridge_response';
        throw error;
    }
    if (!response.ok || payload?.ok === false) {
        const error = new Error(payload?.error || `Bridge HTTP ${response.status}`);
        error.code = payload?.code || 'bridge_request_failed';
        throw error;
    }
    return payload;
}

function createAgentBridgeClient({ env = process.env, fetchImpl = global.fetch } = {}) {
    const config = buildAgentBridgeConfig(env);
    if (typeof fetchImpl !== 'function') {
        throw new TypeError('fetchImpl precisa ser uma função.');
    }

    async function request(method, action, payload = {}) {
        if (!config.enabled) {
            return { ok: false, skipped: true, reason: 'bridge_disabled' };
        }
        if (!config.valid) {
            return { ok: false, skipped: true, reason: 'bridge_misconfigured' };
        }

        const timeout = createTimeoutSignal(config.timeoutMs);
        try {
            if (method === 'GET') {
                const url = new URL(config.endpoint);
                url.searchParams.set('action', action);
                url.searchParams.set('secret', config.secret);
                for (const [key, value] of Object.entries(payload || {})) {
                    if (value === undefined || value === null || value === '') continue;
                    url.searchParams.set(key, String(value));
                }
                const response = await fetchImpl(url, {
                    method: 'GET',
                    headers: { accept: 'application/json' },
                    signal: timeout.signal,
                });
                return parseJsonResponse(response);
            }

            const response = await fetchImpl(config.endpoint, {
                method: 'POST',
                headers: {
                    accept: 'application/json',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ action, secret: config.secret, ...payload }),
                signal: timeout.signal,
            });
            return parseJsonResponse(response);
        } catch (error) {
            if (error?.name === 'AbortError') {
                const timeoutError = new Error('Clover Agent Bridge excedeu o timeout.');
                timeoutError.code = 'bridge_timeout';
                throw timeoutError;
            }
            throw error;
        } finally {
            timeout.clear();
        }
    }

    return {
        config,
        async enqueueQuestion({ id, playerId, playerName = '', chatId, question, context = {} }) {
            const cleanId = String(id || '').trim();
            const cleanPlayerId = String(playerId || '').trim();
            const cleanChatId = String(chatId || '').trim();
            const cleanQuestion = String(question || '').trim();
            if (!cleanId || !cleanPlayerId || !cleanChatId || !cleanQuestion) {
                return { ok: false, skipped: true, reason: 'invalid_question' };
            }
            return request('POST', 'enqueue', {
                id: cleanId,
                player_id: cleanPlayerId,
                player_name: String(playerName || '').trim(),
                chat_id: cleanChatId,
                question: cleanQuestion,
                context_json: context,
            });
        },
        async fetchAnswered({ limit = DEFAULT_LIMIT } = {}) {
            const safeLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || DEFAULT_LIMIT));
            const result = await request('GET', 'answers', { limit: safeLimit });
            if (result?.skipped) return result;
            return {
                ...result,
                answers: Array.isArray(result.answers) ? result.answers : [],
            };
        },
        async ackDelivered(id) {
            const cleanId = String(id || '').trim();
            if (!cleanId) return { ok: false, skipped: true, reason: 'invalid_id' };
            return request('POST', 'ack_delivered', { id: cleanId });
        },
    };
}

module.exports = {
    DEFAULT_LIMIT,
    DEFAULT_TIMEOUT_MS,
    buildAgentBridgeConfig,
    buildQuestionId,
    createAgentBridgeClient,
    envFlag,
    normalizeEndpoint,
};
