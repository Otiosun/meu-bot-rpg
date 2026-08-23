'use strict';

const { RaidRewardProposalError } = require('./raidRewardProposalService');
const {
    reviewRaidRewardProposalGuarded,
} = require('./raidRewardProposalReviewGuardService');
const { runEconomyMutationExclusive } = require('./economyMutationQueue');
const { authenticateSiteSession } = require('./siteAuthService');
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
    if (!(error instanceof RaidRewardProposalError)) return Number(error?.status || 500);
    if (error.code === 'proposal_not_found' || error.code === 'raid_not_found') return 404;
    if (['forbidden', 'self_review_blocked', 'raid_host_required'].includes(error.code)) return 403;
    if ([
        'proposal_not_pending',
        'proposal_stale',
        'idempotency_conflict',
        'idempotency_in_progress',
        'idempotency_stale_intent',
        'idempotency_review_receipt_missing',
    ].includes(error.code)) return 409;
    return 400;
}

const RAID_REWARD_PROPOSAL_REVIEW_ROUTE_DESCRIPTORS = Object.freeze([
    routeDescriptor({ id: 'raid.reward-proposal.review', methods: ['POST'], template: '/raid-reward-proposals/:proposalId/review', samplePath: '/raid-reward-proposals/example-proposal/review', match: (pathname) => /^\/raid-reward-proposals\/[^/]+\/review$/.test(String(pathname || '')), handlerOwner: 'handleRaidRewardProposalIdempotentHttp', sourceFile: 'helpers/clover/raidRewardProposalIdempotentHttp.js', authClass: 'SITE_SESSION:RAID_REWARD_REVIEWER', contractId: 'raid-reward-proposal-review-v1' }),
]);

async function handleRaidRewardProposalIdempotentHttp(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const match = url.pathname.match(/^\/raid-reward-proposals\/([^/]+)\/review$/);
    const descriptor = matchDescriptor(RAID_REWARD_PROPOSAL_REVIEW_ROUTE_DESCRIPTORS, method, url.pathname);
    if (!match || (!descriptor && method !== 'OPTIONS')) return false;

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
        const proposalId = decodeURIComponent(match[1]);
        const review = options.reviewRaidRewardProposal
            || reviewRaidRewardProposalGuarded;
        const runner = options.mutationRunner || runEconomyMutationExclusive;
        const result = await runner(
            () => review(db, {
                proposalId,
                actorId: auth.player.id,
                decision: body.decision,
                note: body.note,
                ...(idempotencyKey ? { idempotencyKey } : {}),
            }),
            { operation: `site:raid-reward-proposal-review:${proposalId}` }
        );
        sendJson(res, 200, result);
        return true;
    } catch (error) {
        sendJson(res, statusForError(error), {
            ok: false,
            error: error?.code || 'raid_reward_proposal_review_failed',
            message: error?.message || 'Não foi possível revisar a proposta de recompensa.',
            details: error?.details || null,
        });
        return true;
    }
}

module.exports = {
    RAID_REWARD_PROPOSAL_REVIEW_ROUTE_DESCRIPTORS,
    handleRaidRewardProposalIdempotentHttp,
    statusForError,
};
