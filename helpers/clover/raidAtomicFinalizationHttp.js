'use strict';

const { beginRaidFinalizationAtomic } = require('./raidAtomicFinalizationService');
const { RaidServiceError } = require('./raidService');
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
    const match = String(req.headers?.authorization || '').trim().match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

function statusForError(error) {
    if (!(error instanceof RaidServiceError)) return Number(error?.status || 500);
    if (error.code === 'raid_not_found') return 404;
    if (['raid_host_required', 'raid_forbidden'].includes(error.code)) return 403;
    if (['raid_not_in_progress', 'raid_state_changed'].includes(error.code)) return 409;
    return 400;
}

const RAID_ATOMIC_FINALIZATION_ROUTE_DESCRIPTORS = Object.freeze([
    routeDescriptor({ id: 'raid.finalization.start', methods: ['POST'], template: '/raids/:raidKey/finalize', samplePath: '/raids/example-raid/finalize', match: (pathname) => /^\/raids\/[^/]+\/finalize$/.test(String(pathname || '')), handlerOwner: 'handleRaidAtomicFinalizationHttp', sourceFile: 'helpers/clover/raidAtomicFinalizationHttp.js', authClass: 'SITE_SESSION:RAID_HOST', contractId: 'raid-finalization-start-v1' }),
]);

async function handleRaidAtomicFinalizationHttp(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const descriptor = matchDescriptor(RAID_ATOMIC_FINALIZATION_ROUTE_DESCRIPTORS, method, url.pathname);
    const match = url.pathname.match(/^\/raids\/([^/]+)\/finalize$/);
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

        const beginFinalization = options.beginRaidFinalization || beginRaidFinalizationAtomic;
        const runner = options.mutationRunner || runEconomyMutationExclusive;
        const raidKey = decodeURIComponent(match[1]);
        const result = await runner(
            () => beginFinalization(db, raidKey, auth.player.id),
            { operation: `site:raid-finalize:${raidKey}` }
        );
        sendJson(res, 200, result);
        return true;
    } catch (error) {
        sendJson(res, statusForError(error), {
            ok: false,
            error: error?.code || 'raid_finalization_start_failed',
            message: error?.message || 'Não foi possível abrir a finalização da Raid.',
            details: error?.details || null,
        });
        return true;
    }
}

module.exports = {
    RAID_ATOMIC_FINALIZATION_ROUTE_DESCRIPTORS,
    handleRaidAtomicFinalizationHttp,
    statusForError,
};
