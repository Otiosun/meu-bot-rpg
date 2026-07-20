'use strict';

const http = require('http');
const base = require('./siteApiServerBase');
const { getRaidCategoryCatalog } = require('./raidService');
const { getSquadOperations } = require('./siteSquadOperationsService');
const { authenticateSiteSession } = require('./siteAuthService');

function setCors(req, res) {
    const configured = String(process.env.CLOVER_SITE_API_ORIGIN || '*').trim() || '*';
    const origin = configured === '*'
        ? '*'
        : String(req.headers?.origin || configured);
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Idempotency-Key, X-Request-Id, ngrok-skip-browser-warning'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function sendJson(res, status, payload) {
    if (res.headersSent) return;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function bearerToken(req) {
    const authorization = String(req.headers?.authorization || '').trim();
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

function routePath(req) {
    return new URL(req.url || '/', 'http://localhost').pathname;
}

function handleRaidCatalog(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    const pathname = routePath(req);
    if (!['/raids/categories', '/raid-categories'].includes(pathname)) return false;
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
    const categories = getRaidCategoryCatalog();
    res.setHeader('Cache-Control', 'public, max-age=60');
    sendJson(res, 200, { ok: true, categories, categorias: categories });
    return true;
}

function squadOperationsMatch(req) {
    const pathname = routePath(req);
    const match = pathname.match(/^\/squads\/([^/]+)\/operations$/);
    return match ? decodeURIComponent(match[1]) : null;
}

async function handleSquadOperations(req, res, options) {
    const squadInput = squadOperationsMatch(req);
    if (!squadInput) return false;

    setCors(req, res);
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }
    if (method !== 'GET') {
        sendJson(res, 405, {
            ok: false,
            error: 'method_not_allowed',
            message: 'Este endpoint aceita apenas leitura.',
        });
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

    const auth = await authenticateSiteSession(db, bearerToken(req));
    if (!auth.ok) {
        sendJson(res, 401, {
            ok: false,
            error: auth.reason || 'unauthorized',
            message: 'Sua sessão expirou. Entre novamente no painel.',
        });
        return true;
    }

    const operations = await getSquadOperations(db, {
        actorId: auth.player.id,
        squadInput,
    });
    if (!operations.ok) {
        const notFound = operations.code === 'squad_not_found';
        sendJson(res, notFound ? 404 : 403, {
            ok: false,
            error: operations.code,
            message: notFound
                ? 'Esquadrão não encontrado.'
                : 'Sua sessão não pode consultar este esquadrão.',
        });
        return true;
    }

    res.setHeader('Cache-Control', 'private, no-store');
    sendJson(res, 200, { ok: true, operations, operacoes: operations });
    return true;
}

async function handleExtendedRoute(req, res, options) {
    if (handleRaidCatalog(req, res)) return true;
    return handleSquadOperations(req, res, options);
}

function startSiteApiServer(options = {}) {
    const originalCreateServer = http.createServer;
    http.createServer = function createExtendedSiteServer(listener) {
        return originalCreateServer.call(http, (req, res) => {
            handleExtendedRoute(req, res, options)
                .then((handled) => {
                    if (!handled) listener(req, res);
                })
                .catch((error) => {
                    console.log('[site-api] extended_route_error', error?.stack || error?.message || error);
                    sendJson(res, 500, {
                        ok: false,
                        error: 'extended_route_error',
                        message: 'Erro interno ao carregar o painel.',
                    });
                });
        });
    };
    try {
        return base.startSiteApiServer(options);
    } finally {
        http.createServer = originalCreateServer;
    }
}

module.exports = {
    ...base,
    startSiteApiServer,
};
