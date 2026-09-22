'use strict';

const { ensureEconomyV1 } = require('./economyService');
const {
    getActiveShopCatalogVersion,
    listShopCatalogVersions,
    pendingPurchaseCount,
} = require('./shopCatalogVersionService');

function setCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Idempotency-Key, X-Request-Id, ngrok-skip-browser-warning'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function requireCapability(access, capability) {
    if (access?.actor?.capabilities?.includes(capability)) return;
    const error = new Error('Seu perfil não possui a permissão necessária.');
    error.code = 'missing_capability';
    error.status = 403;
    error.details = { capability };
    throw error;
}

function parseAdminShopPath(pathname) {
    const path = String(pathname || '');
    return path === '/admin/shops' ? { kind: 'dashboard' } : null;
}

async function getAdminShopDashboard(db) {
    await ensureEconomyV1(db);
    const [versions, active, pending] = await Promise.all([
        listShopCatalogVersions(db),
        getActiveShopCatalogVersion(db),
        pendingPurchaseCount(db),
    ]);
    return {
        ok: true,
        immutableActive: true,
        activeVersion: active?.version || null,
        pendingPurchaseCount: pending,
        versions,
    };
}

async function handleAdminShopHttp(req, res, options = {}, parsedPath = null) {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = parsedPath || parseAdminShopPath(url.pathname);
    if (!route) return false;

    setCors(req, res);
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }

    const resolveContext = options.resolveAdminContext;
    if (typeof resolveContext !== 'function') {
        sendJson(res, 500, {
            ok: false,
            error: 'admin_context_resolver_missing',
            message: 'Contexto administrativo indisponível.',
        });
        return true;
    }

    const context = await resolveContext(req, res, options);
    if (!context) return true;

    try {
        if (method !== 'GET') {
            const error = new Error('Método não permitido.');
            error.code = 'method_not_allowed';
            error.status = 405;
            throw error;
        }
        requireCapability(context.access, 'catalog.view');
        const resolver = options.adminShopDashboard || getAdminShopDashboard;
        sendJson(res, 200, await resolver(context.db, { actorId: context.access.actor.id }));
    } catch (error) {
        sendJson(res, Number(error?.status || 400), {
            ok: false,
            error: error?.code || 'admin_shop_request_failed',
            message: error?.message || 'Não foi possível consultar as Lojas.',
            details: error?.details || null,
        });
    }
    return true;
}

module.exports = {
    getAdminShopDashboard,
    handleAdminShopHttp,
    parseAdminShopPath,
};
