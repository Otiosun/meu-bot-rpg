'use strict';

const { authenticateSiteSession } = require('./siteAuthService');
const { getIntegratedAccessContext, contextCanAnywhere } = require('./integratedAccessContextService');
const { getTransitionDashboard } = require('./preResetTransitionService');

const ROUTE = '/pre-reset/admin/transition/dashboard';
const CAPABILITY = 'prereset.review';

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
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

async function handlePreResetTransitionAdminHttp(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== ROUTE) return false;

    setCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }
    if (method !== 'GET') {
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
    const readDashboard = options.getTransitionDashboard || getTransitionDashboard;

    try {
        const auth = await authenticate(db, bearerToken(req));
        if (!auth?.ok || !auth?.player?.id) {
            sendJson(res, 401, { ok: false, error: auth?.reason || 'unauthorized' });
            return true;
        }

        const access = await resolveAccess(db, auth.player.id, options.accessOptions || {});
        if (!contextCanAnywhere(access, CAPABILITY)) {
            sendJson(res, 403, { ok: false, error: 'capability_denied' });
            return true;
        }

        const dashboard = await readDashboard(db);
        sendJson(res, 200, {
            ok: true,
            dashboard,
            painel: dashboard,
        });
        return true;
    } catch (error) {
        console.log('[pre-reset-transition-admin] falha ao carregar dashboard:', error?.message || error);
        sendJson(res, 500, {
            ok: false,
            error: 'internal_error',
            message: 'Nao foi possivel carregar o painel de transicao.',
        });
        return true;
    }
}

module.exports = {
    CAPABILITY,
    ROUTE,
    handlePreResetTransitionAdminHttp,
};
