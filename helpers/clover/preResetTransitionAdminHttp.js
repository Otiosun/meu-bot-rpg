'use strict';

const { authenticateSiteSession } = require('./siteAuthService');
const { getIntegratedAccessContext, contextCanAnywhere } = require('./integratedAccessContextService');
const {
    getPreResetAdminOverview,
    getPreResetPlayerDetail,
    reviewPreResetFutureCharacter,
    searchPreResetPlayers,
} = require('./preResetAdminService');
const { configurePreResetCampaign } = require('./preResetCampaignStateService');
const { closePreResetCampaign } = require('./preResetCampaignCloseService');
const { previewPreResetPurge, executePreResetPurge } = require('./preResetPurgeService');

const ROUTE = '/pre-reset/admin/transition/dashboard';
const ADMIN_PREFIX = '/pre-reset/admin';
const CAPABILITY = 'prereset.review';

const ROUTES = Object.freeze({
    dashboard: ROUTE,
    overview: `${ADMIN_PREFIX}/overview`,
    players: `${ADMIN_PREFIX}/players`,
    player: `${ADMIN_PREFIX}/player`,
    review: `${ADMIN_PREFIX}/review`,
    campaignConfigure: `${ADMIN_PREFIX}/campaign/configure`,
    campaignClose: `${ADMIN_PREFIX}/campaign/close`,
    purgePreview: `${ADMIN_PREFIX}/purge/preview`,
    purgeExecute: `${ADMIN_PREFIX}/purge/execute`,
});

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

function setCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function requiredCapabilities(pathname) {
    if (pathname === ROUTES.purgePreview || pathname === ROUTES.purgeExecute) return ['player.manage'];
    if (pathname === ROUTES.campaignClose) return ['prereset.review', 'operation.apply'];
    return ['prereset.review'];
}

function mutationContext(access, actorId, options = {}) {
    const all = ['prereset.review', 'player.manage', 'operation.apply'];
    return {
        actorId,
        capabilities: all.filter((capability) => contextCanAnywhere(access, capability)),
        env: options.env || process.env,
        policyRegistry: options.policyRegistry,
        surface: 'admin',
    };
}

function readJsonBody(req, maxBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                const error = new Error('payload_too_large');
                error.code = 'payload_too_large';
                reject(error);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                const text = Buffer.concat(chunks).toString('utf8').trim();
                resolve(text ? JSON.parse(text) : {});
            } catch (error) {
                error.code = 'invalid_json';
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function errorStatus(error) {
    const code = String(error?.code || '');
    if (['capability_denied', 'prereset_mode_disabled', 'policy_disabled', 'session_not_eligible'].includes(code)) return 403;
    if (code === 'player_not_found') return 404;
    if (['idempotency_conflict', 'revision_conflict', 'transition_revision_conflict', 'transition_decision_irreversible',
        'player_already_purged', 'closure_operation_conflict', 'campaign_close_state_conflict', 'campaign_not_editable'].includes(code)) return 409;
    if (code === 'payload_too_large') return 413;
    return 400;
}

function routeKnown(pathname) {
    return Object.values(ROUTES).includes(pathname);
}

async function handlePreResetTransitionAdminHttp(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    if (!routeKnown(url.pathname)) return false;

    setCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }
    const getRoutes = new Set([ROUTES.dashboard, ROUTES.overview, ROUTES.players, ROUTES.player]);
    const postRoutes = new Set([ROUTES.review, ROUTES.campaignConfigure, ROUTES.campaignClose, ROUTES.purgePreview, ROUTES.purgeExecute]);
    if ((getRoutes.has(url.pathname) && method !== 'GET') || (postRoutes.has(url.pathname) && method !== 'POST')) {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return true;
    }

    const db = options.getDb?.();
    if (!db) {
        sendJson(res, 503, { ok: false, error: 'database_unavailable' });
        return true;
    }

    const authenticate = options.authenticateSiteSession || authenticateSiteSession;
    const resolveAccess = options.getIntegratedAccessContext || getIntegratedAccessContext;

    try {
        const auth = await authenticate(db, bearerToken(req));
        if (!auth?.ok || !auth?.player?.id) {
            sendJson(res, 401, { ok: false, error: auth?.reason || 'unauthorized' });
            return true;
        }
        const access = await resolveAccess(db, auth.player.id, options.accessOptions || {});
        const required = requiredCapabilities(url.pathname);
        if (!required.every((capability) => contextCanAnywhere(access, capability))) {
            sendJson(res, 403, { ok: false, error: 'capability_denied' });
            return true;
        }
        const context = mutationContext(access, auth.player.id, options);

        if (url.pathname === ROUTES.dashboard || url.pathname === ROUTES.overview) {
            const overview = await (options.getPreResetAdminOverview || getPreResetAdminOverview)(db, { now: options.now || Date.now() });
            sendJson(res, 200, { ok: true, dashboard: overview, painel: overview });
            return true;
        }
        if (url.pathname === ROUTES.players) {
            const players = await (options.searchPreResetPlayers || searchPreResetPlayers)(db, url.searchParams.get('query') || '', {
                limit: url.searchParams.get('limit'),
            });
            sendJson(res, 200, { ok: true, players });
            return true;
        }
        if (url.pathname === ROUTES.player) {
            const player = await (options.getPreResetPlayerDetail || getPreResetPlayerDetail)(db, url.searchParams.get('playerId'));
            sendJson(res, 200, { ok: true, player });
            return true;
        }

        const body = await readJsonBody(req);
        if (url.pathname === ROUTES.review) {
            const result = await (options.reviewPreResetFutureCharacter || reviewPreResetFutureCharacter)(db, context, body);
            sendJson(res, 200, { ok: true, result });
            return true;
        }
        if (url.pathname === ROUTES.campaignConfigure) {
            const result = await (options.configurePreResetCampaign || configurePreResetCampaign)(db, context, body);
            sendJson(res, 200, { ok: true, result });
            return true;
        }
        if (url.pathname === ROUTES.campaignClose) {
            const result = await (options.closePreResetCampaign || closePreResetCampaign)(db, context, body);
            sendJson(res, 200, { ok: true, result });
            return true;
        }
        if (url.pathname === ROUTES.purgePreview) {
            const result = await (options.previewPreResetPurge || previewPreResetPurge)(db, context, body);
            sendJson(res, 200, { ok: true, result });
            return true;
        }
        if (url.pathname === ROUTES.purgeExecute) {
            if (!contextCanAnywhere(access, 'operation.apply')) {
                sendJson(res, 403, { ok: false, error: 'capability_denied' });
                return true;
            }
            const result = await (options.executePreResetPurge || executePreResetPurge)(db, context, body);
            sendJson(res, 200, { ok: true, result });
            return true;
        }
    } catch (error) {
        const status = errorStatus(error);
        console.log('[pre-reset-admin] request rejeitada:', error?.code || error?.message || error);
        sendJson(res, status, {
            ok: false,
            error: error?.code || 'request_failed',
            message: error?.message || 'Falha no modulo administrativo pre-reset.',
            details: error?.details || undefined,
        });
        return true;
    }
    return false;
}

module.exports = {
    ADMIN_PREFIX,
    CAPABILITY,
    ROUTE,
    ROUTES,
    handlePreResetTransitionAdminHttp,
    readJsonBody,
};
