'use strict';

const { authenticateSiteSession } = require('./siteAuthService');
const { SquadMembershipError } = require('./squadMembershipService');
const { transferSquadMember } = require('./squadMembershipTransitionService');
const { matchDescriptor, routeDescriptor } = require('./httpRouteDescriptor');

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
            error.code = 'payload_too_large';
            error.status = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        const error = new Error('JSON inválido.');
        error.code = 'invalid_json';
        error.status = 400;
        throw error;
    }
}

function transferHttpStatus(error) {
    const forbidden = new Set(['forbidden', 'leadership_transfer_blocked']);
    const notFound = new Set(['squad_not_found', 'player_not_found']);
    const conflict = new Set([
        'same_squad_transfer',
        'active_membership_missing',
        'multiple_active_memberships',
        'membership_transfer_source_conflict',
        'membership_transfer_concurrency_conflict',
        'membership_transfer_target_missing',
        'membership_transfer_projection_failed',
        'membership_transfer_postcondition_failed',
        'membership_transition_idempotency_conflict',
        'membership_transition_not_completed',
        'membership_transition_receipt_corrupt',
    ]);
    if (forbidden.has(error?.code)) return 403;
    if (notFound.has(error?.code)) return 404;
    if (conflict.has(error?.code)) return 409;
    return Number(error?.status || 400);
}

const SQUAD_MEMBERSHIP_TRANSFER_ROUTE_DESCRIPTORS = Object.freeze([
    routeDescriptor({ id: 'squad.member.transfer', methods: ['POST'], template: '/squads/:fromSquad/members/:playerId/transfer', samplePath: '/squads/example-squad/members/player-example/transfer', match: (pathname) => /^\/squads\/[^/]+\/members\/[^/]+\/transfer$/.test(String(pathname || '')), handlerOwner: 'handleSquadMembershipTransferHttp', sourceFile: 'helpers/clover/squadMembershipTransferHttp.js', authClass: 'SITE_SESSION:SQUAD_CAPTAIN', contractId: 'squad-member-transfer-v1' }),
]);

async function handleSquadMembershipTransferHttp(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const match = url.pathname.match(/^\/squads\/([^/]+)\/members\/([^/]+)\/transfer$/);
    const descriptor = matchDescriptor(SQUAD_MEMBERSHIP_TRANSFER_ROUTE_DESCRIPTORS, method, url.pathname);
    const recognizedPath = descriptor || SQUAD_MEMBERSHIP_TRANSFER_ROUTE_DESCRIPTORS.some((route) => route.match(url.pathname));
    if (!match || !recognizedPath) return false;

    setCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }
    if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
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

    try {
        const body = await readJsonBody(req);
        const idempotencyKey = String(
            req.headers?.['idempotency-key']
            || body.idempotencyKey
            || body.idempotency_key
            || ''
        ).trim();
        if (!idempotencyKey) {
            sendJson(res, 400, {
                ok: false,
                error: 'missing_idempotency_key',
                message: 'Envie Idempotency-Key para transferir o membro.',
            });
            return true;
        }
        const targetSquad = String(
            body.toSquad
            || body.to_squad
            || body.targetSquad
            || body.target_squad
            || ''
        ).trim();
        if (!targetSquad) {
            sendJson(res, 400, {
                ok: false,
                error: 'missing_target_squad',
                message: 'Informe o esquadrão de destino.',
            });
            return true;
        }

        const transfer = options.transferMember || transferSquadMember;
        const result = await transfer(db, {
            actorId: auth.player.id,
            characterId: decodeURIComponent(match[2]),
            fromSquadInput: decodeURIComponent(match[1]),
            toSquadInput: targetSquad,
            reason: body.reason || body.motivo,
            transitionKey: idempotencyKey,
        });
        sendJson(res, result.duplicate ? 200 : 201, result);
        return true;
    } catch (error) {
        if (!(error instanceof SquadMembershipError) && !error?.code) throw error;
        sendJson(res, transferHttpStatus(error), {
            ok: false,
            error: error.code || 'membership_transfer_failed',
            message: error.message || 'Não foi possível transferir o membro.',
            details: error.details || null,
        });
        return true;
    }
}

module.exports = {
    SQUAD_MEMBERSHIP_TRANSFER_ROUTE_DESCRIPTORS,
    bearerToken,
    handleSquadMembershipTransferHttp,
    readJsonBody,
    sendJson,
    setCors,
    transferHttpStatus,
};
