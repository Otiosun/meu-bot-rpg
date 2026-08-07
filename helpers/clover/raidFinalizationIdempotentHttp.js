'use strict';

const { RaidServiceError } = require('./raidService');
const {
    setRaidParticipantFinalizationIdempotent,
} = require('./raidFinalizationIdempotencyService');
const { runEconomyMutationExclusive } = require('./economyMutationQueue');
const { authenticateSiteSession } = require('./siteAuthService');

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

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

function bearerToken(req) {
    const value = String(req.headers?.authorization || '').trim();
    const match = value.match(/^Bearer\s+(.+)$/i);
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

function statusForError(error) {
    if (!(error instanceof RaidServiceError)) return Number(error?.status || 500);
    if (['raid_not_found', 'participant_not_active'].includes(error.code)) return 404;
    if (['raid_host_required', 'raid_forbidden'].includes(error.code)) return 403;
    if ([
        'raid_not_in_finalization',
        'idempotency_conflict',
        'idempotency_in_progress',
        'idempotency_claim_lost',
    ].includes(error.code)) return 409;
    return 400;
}

async function handleRaidFinalizationIdempotentHttp(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const match = url.pathname.match(
        /^\/raids\/([^/]+)\/finalization\/participants\/([^/]+)$/
    );
    if (!match) return false;
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
        const idempotencyKey = String(
            req.headers?.['idempotency-key']
            || body.idempotencyKey
            || body.idempotency_key
            || ''
        ).trim();
        const raidKey = decodeURIComponent(match[1]);
        const targetPlayerId = decodeURIComponent(match[2]);
        const review = options.setRaidParticipantFinalization
            || setRaidParticipantFinalizationIdempotent;
        const runner = options.mutationRunner || runEconomyMutationExclusive;
        const result = await runner(
            () => review(
                db,
                raidKey,
                auth.player.id,
                targetPlayerId,
                {
                    ...body,
                    ...(idempotencyKey ? { idempotencyKey } : {}),
                }
            ),
            { operation: `site:raid-finalization-review:${raidKey}` }
        );
        sendJson(res, 200, result);
        return true;
    } catch (error) {
        sendJson(res, statusForError(error), {
            ok: false,
            error: error?.code || 'raid_finalization_review_failed',
            message: error?.message || 'Não foi possível revisar a elegibilidade.',
            details: error?.details || null,
        });
        return true;
    }
}

module.exports = {
    handleRaidFinalizationIdempotentHttp,
    statusForError,
};
