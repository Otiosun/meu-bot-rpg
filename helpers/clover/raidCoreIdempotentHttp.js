'use strict';

const {
    addRaidCondition,
    addRaidReward,
    createRaid,
} = require('./raidService');
const { raidMutationStatus } = require('./raidIdempotentHttp');
const { runEconomyMutationExclusive } = require('./economyMutationQueue');
const { authenticateSiteSession } = require('./siteAuthService');

function setCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Idempotency-Key, X-Request-Id, ngrok-skip-browser-warning'
    );
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function bearerToken(req) {
    const match = String(req.headers?.authorization || '').trim().match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > maxBytes) {
            const error = new Error('Corpo da requisição grande demais.');
            error.status = 413;
            error.code = 'payload_too_large';
            throw error;
        }
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        const error = new Error('JSON inválido.');
        error.status = 400;
        error.code = 'invalid_json';
        throw error;
    }
}

function requestIdempotencyKey(req, body = {}) {
    return String(
        req.headers?.['idempotency-key']
        || body.idempotencyKey
        || body.idempotency_key
        || ''
    ).trim();
}

function parseCoreRoute(pathname) {
    const path = String(pathname || '');
    if (path === '/raids') return { kind: 'create' };
    let match = path.match(/^\/raids\/([^/]+)\/conditions$/);
    if (match) return { kind: 'condition-add', raidKey: decodeURIComponent(match[1]) };
    match = path.match(/^\/raids\/([^/]+)\/rewards$/);
    if (match) return { kind: 'reward-add', raidKey: decodeURIComponent(match[1]) };
    return null;
}

async function handleRaidCoreIdempotentHttp(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const route = parseCoreRoute(url.pathname);
    if (!route) return false;
    if (!['POST', 'OPTIONS'].includes(method)) return false;

    setCors(req, res);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }

    const db = options.getDb?.();
    if (!db) {
        sendJson(res, 503, {
            ok: false,
            error: 'database_unavailable',
            message: 'Banco ainda não está pronto.',
        });
        return true;
    }

    try {
        const authenticate = options.authenticateSession || authenticateSiteSession;
        const auth = await authenticate(db, bearerToken(req));
        if (!auth?.ok || !auth.player?.id) {
            sendJson(res, 401, {
                ok: false,
                error: auth?.reason || 'invalid_session',
                message: 'Sessão inválida ou expirada.',
            });
            return true;
        }

        const body = await readJsonBody(req);
        const idempotencyKey = requestIdempotencyKey(req, body);
        const input = {
            ...body,
            ...(idempotencyKey ? { idempotencyKey } : {}),
        };
        const runner = options.mutationRunner || runEconomyMutationExclusive;

        if (route.kind === 'create') {
            const create = options.createRaid || createRaid;
            const result = await runner(
                () => create(db, auth.player.id, input),
                { operation: 'site:raid-create' }
            );
            sendJson(res, result?.duplicate ? 200 : 201, result);
            return true;
        }

        if (route.kind === 'condition-add') {
            const addCondition = options.addRaidCondition || addRaidCondition;
            const result = await runner(
                () => addCondition(db, route.raidKey, auth.player.id, input),
                { operation: `site:raid-condition-add:${route.raidKey}` }
            );
            sendJson(res, result?.duplicate ? 200 : 201, result);
            return true;
        }

        const addReward = options.addRaidReward || addRaidReward;
        const result = await runner(
            () => addReward(db, route.raidKey, auth.player.id, input),
            { operation: `site:raid-reward-add:${route.raidKey}` }
        );
        sendJson(res, result?.duplicate ? 200 : 201, result);
        return true;
    } catch (error) {
        sendJson(res, raidMutationStatus(error), {
            ok: false,
            error: error?.code || 'raid_mutation_failed',
            message: error?.message || 'Não foi possível concluir a alteração da Raid.',
            details: error?.details || null,
        });
        return true;
    }
}

module.exports = {
    handleRaidCoreIdempotentHttp,
    parseCoreRoute,
    requestIdempotencyKey,
};
