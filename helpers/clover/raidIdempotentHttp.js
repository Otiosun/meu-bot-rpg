'use strict';

const {
    RaidServiceError,
    addRaidHost,
    setRaidLoadoutSlot,
} = require('./raidService');
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
    res.setHeader('Access-Control-Allow-Methods', 'POST, PUT, OPTIONS');
}

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function bearerToken(req) {
    const value = String(req.headers?.authorization || '').trim();
    const match = value.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

async function requireSession(db, req, authenticate = authenticateSiteSession) {
    const auth = await authenticate(db, bearerToken(req));
    if (!auth?.ok || !auth.player?.id) {
        const error = new Error('Sessão inválida ou expirada.');
        error.status = 401;
        error.code = auth?.reason || 'invalid_session';
        throw error;
    }
    return auth;
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

function raidMutationStatus(error) {
    if (!(error instanceof RaidServiceError)) return Number(error?.status || 500);
    const notFound = new Set([
        'raid_not_found',
        'player_not_found',
        'participant_not_found',
        'host_not_found',
        'item_not_found',
        'loadout_item_not_found',
    ]);
    const forbidden = new Set([
        'narrator_required',
        'raid_host_required',
        'principal_owner_required',
        'raid_forbidden',
        'loadout_forbidden',
        'game_blocked',
    ]);
    const conflict = new Set([
        'idempotency_conflict',
        'idempotency_in_progress',
        'idempotency_claim_lost',
        'raid_closed',
        'loadout_locked',
        'item_reserved',
        'insufficient_available_quantity',
        'reservation_conflict',
        'two_handed_conflict',
    ]);
    if (notFound.has(error.code)) return 404;
    if (forbidden.has(error.code)) return 403;
    if (conflict.has(error.code)) return 409;
    return 400;
}

function parseRoute(pathname) {
    const host = String(pathname || '').match(/^\/raids\/([^/]+)\/hosts$/);
    if (host) {
        return {
            kind: 'host',
            raidKey: decodeURIComponent(host[1]),
        };
    }
    const loadout = String(pathname || '').match(/^\/raids\/([^/]+)\/loadout\/([^/]+)$/);
    if (loadout) {
        return {
            kind: 'loadout',
            raidKey: decodeURIComponent(loadout[1]),
            slot: decodeURIComponent(loadout[2]),
        };
    }
    return null;
}

async function handleRaidIdempotentHttp(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const route = parseRoute(url.pathname);
    if (!route) return false;

    if (
        (route.kind === 'host' && !['POST', 'OPTIONS'].includes(method))
        || (route.kind === 'loadout' && !['PUT', 'OPTIONS'].includes(method))
    ) {
        return false;
    }

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
        const auth = await requireSession(
            db,
            req,
            options.authenticateSession || authenticateSiteSession
        );
        const body = await readJsonBody(req);
        const idempotencyKey = requestIdempotencyKey(req, body);

        if (route.kind === 'host') {
            const targetPlayerId = body.playerId || body.player_id;
            if (!targetPlayerId) {
                sendJson(res, 400, {
                    ok: false,
                    error: 'missing_player_id',
                    message: 'Informe playerId do co-host.',
                });
                return true;
            }
            const runner = options.mutationRunner || runEconomyMutationExclusive;
            const addHost = options.addRaidHost || addRaidHost;
            const result = await runner(
                () => addHost(
                    db,
                    route.raidKey,
                    auth.player.id,
                    targetPlayerId,
                    { idempotencyKey }
                ),
                { operation: `site:raid-host-add:${route.raidKey}` }
            );
            sendJson(res, 200, result);
            return true;
        }

        const runner = options.mutationRunner || runEconomyMutationExclusive;
        const setLoadout = options.setRaidLoadoutSlot || setRaidLoadoutSlot;
        const result = await runner(
            () => setLoadout(
                db,
                route.raidKey,
                auth.player.id,
                route.slot,
                {
                    ...body,
                    ...(idempotencyKey ? { idempotencyKey } : {}),
                }
            ),
            { operation: `site:raid-loadout:${route.raidKey}:${route.slot}` }
        );
        sendJson(res, 200, result);
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
    handleRaidIdempotentHttp,
    parseRoute,
    raidMutationStatus,
    requestIdempotencyKey,
};
