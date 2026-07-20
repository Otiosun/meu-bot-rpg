'use strict';

const http = require('http');
const base = require('./siteApiServerBase');
const { getRaidCategoryCatalog } = require('./raidService');
const { authenticateSiteSession } = require('./siteAuthService');
const {
    getRaidCreationOptions,
    previewRaidMonthlyUsage,
} = require('./raidV2OptionsService');
const { getSquadOperations } = require('./siteSquadOperationsService');

function setPublicCors(req, res) {
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

function bearerToken(req) {
    const value = String(req.headers?.authorization || '').trim();
    const match = value.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

async function requireSiteSession(db, req) {
    const auth = await authenticateSiteSession(db, bearerToken(req));
    if (!auth.ok) {
        const error = new Error('Sessão inválida ou expirada.');
        error.status = 401;
        error.code = auth.reason || 'invalid_token';
        throw error;
    }
    return auth;
}

function handleRaidCatalog(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    if (!['/raids/categories', '/raid-categories'].includes(url.pathname)) return false;
    setPublicCors(req, res);
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

async function handleRaidSupport(req, res, options) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const supported = ['/raids/options', '/raids/usage'];
    if (!supported.includes(url.pathname)) return false;

    setPublicCors(req, res);
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
        sendJson(res, 503, {
            ok: false,
            error: 'database_unavailable',
            message: 'Banco ainda não está pronto.',
        });
        return true;
    }

    const auth = await requireSiteSession(db, req);
    if (url.pathname === '/raids/options') {
        const optionsPayload = await getRaidCreationOptions(db, auth.player.id);
        sendJson(res, 200, { ok: true, options: optionsPayload, ...optionsPayload });
        return true;
    }

    const preview = await previewRaidMonthlyUsage(db, auth.player.id, {
        category: url.searchParams.get('category'),
        scopePlayerId: url.searchParams.get('scopePlayerId'),
        scopeSquadKey: url.searchParams.get('scopeSquadKey'),
    });
    sendJson(res, 200, { ok: true, preview });
    return true;
}

async function handleSquadSupport(req, res, options) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const match = url.pathname.match(/^\/squads\/([^/]+)\/operations$/);
    if (!match) return false;

    setPublicCors(req, res);
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
        sendJson(res, 503, {
            ok: false,
            error: 'database_unavailable',
            message: 'Banco ainda não está pronto.',
        });
        return true;
    }

    const auth = await requireSiteSession(db, req);
    const operations = await getSquadOperations(db, {
        actorId: auth.player.id,
        squadInput: decodeURIComponent(match[1]),
    });
    if (!operations.ok) {
        const status = operations.code === 'squad_not_found' ? 404 : 403;
        sendJson(res, status, {
            ok: false,
            error: operations.code,
            message: status === 404
                ? 'Esquadrão não encontrado.'
                : 'Sua sessão não pode consultar este esquadrão.',
        });
        return true;
    }

    sendJson(res, 200, {
        ok: true,
        operations,
        operacoes: operations,
    });
    return true;
}

function startSiteApiServer(options = {}) {
    const originalCreateServer = http.createServer;
    http.createServer = function createRaidV2AwareServer(listener) {
        return originalCreateServer.call(http, (req, res) => {
            Promise.resolve()
                .then(async () => {
                    if (handleRaidCatalog(req, res)) return true;
                    if (await handleRaidSupport(req, res, options)) return true;
                    return handleSquadSupport(req, res, options);
                })
                .then((handled) => {
                    if (!handled) listener(req, res);
                })
                .catch((error) => {
                    if (res.headersSent) {
                        res.end();
                        return;
                    }
                    sendJson(res, Number(error?.status || 500), {
                        ok: false,
                        error: error?.code || 'site_support_error',
                        message: error?.message || 'Erro ao carregar dados do site.',
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
    handleSquadSupport,
    startSiteApiServer,
};
