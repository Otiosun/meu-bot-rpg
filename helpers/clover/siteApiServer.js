'use strict';

const http = require('http');
const base = require('./siteApiServerBase');
const { handleAdminApiSupport } = require('./adminApiSupport');
const { handleCharacterPresentationPreview } = require('./characterPresentationPreviewHttp');
const {
    getPlayerRaidChecklist,
    getRaidCategoryCatalog,
} = require('./raidService');
const { authenticateSiteSession } = require('./siteAuthService');
const { getPublicReceptionState } = require('./receptionService');
const {
    getRaidCreationOptions,
    previewRaidMonthlyUsage,
} = require('./raidV2OptionsService');
const { getSquadOperations } = require('./siteSquadOperationsService');
const { runEconomyMutationExclusive } = require('./economyMutationQueue');
const {
    PrShopServiceError,
    getPrShopDashboard,
    purchasePrShopItem,
} = require('./prShopService');

function setPublicCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Idempotency-Key, X-Request-Id, ngrok-skip-browser-warning'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

async function handleReceptionSupport(req, res, options) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    if (!['/reception', '/recepcao'].includes(url.pathname)) return false;

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
            message: 'A recepção está sendo preparada. Tente novamente em instantes.',
        });
        return true;
    }

    const reception = await getPublicReceptionState(db);
    res.setHeader('Cache-Control', 'public, max-age=30');
    sendJson(res, 200, { ok: true, reception, recepcao: reception });
    return true;
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

async function handlePrShopSupport(req, res, options) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const purchaseMatch = url.pathname.match(/^\/recruitment\/shop(?:\/([^/]+))?\/purchase$/);
    const isDashboard = url.pathname === '/recruitment/shop';
    if (!isDashboard && !purchaseMatch) return false;

    setPublicCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }
    if ((isDashboard && method !== 'GET') || (purchaseMatch && method !== 'POST')) {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return true;
    }

    const db = options.getDb?.();
    if (!db) {
        sendJson(res, 503, { ok: false, error: 'database_unavailable', message: 'Banco ainda não está pronto.' });
        return true;
    }
    const auth = await requireSiteSession(db, req);

    try {
        if (isDashboard) {
            const dashboard = await runEconomyMutationExclusive(
                () => getPrShopDashboard(db, auth.player.id),
                { operation: 'site:pr-shop-dashboard' }
            );
            sendJson(res, 200, {
                ok: true,
                shop: dashboard,
                loja: dashboard,
                items: dashboard.items,
                itens: dashboard.items,
            });
            return true;
        }

        const body = await readJsonBody(req);
        const itemKey = decodeURIComponent(purchaseMatch[1] || body.itemKey || body.item_key || body.codigo || '');
        const idempotencyKey = String(
            req.headers['idempotency-key']
            || body.idempotencyKey
            || body.idempotency_key
            || ''
        ).trim();
        if (!itemKey) {
            sendJson(res, 400, { ok: false, error: 'missing_item_key', message: 'Informe a oferta da Loja de PR.' });
            return true;
        }
        if (!idempotencyKey) {
            sendJson(res, 400, { ok: false, error: 'missing_idempotency_key', message: 'Envie Idempotency-Key para comprar.' });
            return true;
        }
        const purchase = await runEconomyMutationExclusive(
            () => purchasePrShopItem(db, auth.player.id, itemKey, body.quantity || body.quantidade || 1, {
                idempotencyKey,
                createdBy: auth.player.id,
                via: 'site',
            }),
            { operation: `site:pr-shop-purchase:${itemKey}` }
        );
        sendJson(res, purchase.duplicate ? 200 : 201, {
            ok: true,
            purchase,
            compra: purchase,
            shop: purchase.dashboard,
            loja: purchase.dashboard,
        });
        return true;
    } catch (error) {
        if (!(error instanceof PrShopServiceError) && error?.name !== 'PrServiceError') throw error;
        const conflict = new Set(['weekly_limit', 'one_time_limit', 'global_stock', 'idempotency_conflict', 'shop_not_active']);
        const forbidden = new Set(['game_blocked']);
        const notFound = new Set(['shop_item_not_found', 'player_not_found']);
        const status = forbidden.has(error.code) ? 403 : notFound.has(error.code) ? 404 : conflict.has(error.code) ? 409 : 400;
        sendJson(res, status, {
            ok: false,
            error: error.code || 'pr_shop_error',
            message: error.message,
            details: error.details || null,
        });
        return true;
    }
}

async function handleRaidSupport(req, res, options) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const supported = ['/raids/options', '/raids/usage', '/raids/checklist'];
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
        sendJson(res, 503, { ok: false, error: 'database_unavailable', message: 'Banco ainda não está pronto.' });
        return true;
    }

    const auth = await requireSiteSession(db, req);
    if (url.pathname === '/raids/checklist') {
        const checklist = await getPlayerRaidChecklist(db, auth.player.id, {
            monthKey: url.searchParams.get('monthKey') || undefined,
        });
        sendJson(res, 200, {
            ok: true,
            checklist,
            progresso: checklist,
        });
        return true;
    }

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
        sendJson(res, 503, { ok: false, error: 'database_unavailable', message: 'Banco ainda não está pronto.' });
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
            message: status === 404 ? 'Esquadrão não encontrado.' : 'Sua sessão não pode consultar este esquadrão.',
        });
        return true;
    }

    sendJson(res, 200, { ok: true, operations, operacoes: operations });
    return true;
}

function startSiteApiServer(options = {}) {
    const originalCreateServer = http.createServer;
    http.createServer = function createRaidV2AwareServer(listener) {
        return originalCreateServer.call(http, (req, res) => {
            Promise.resolve()
                .then(async () => {
                    if (await handleAdminApiSupport(req, res, options)) return true;
                    if (await handleCharacterPresentationPreview(req, res, options)) return true;
                    if (await handleReceptionSupport(req, res, options)) return true;
                    if (handleRaidCatalog(req, res)) return true;
                    if (await handlePrShopSupport(req, res, options)) return true;
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
    handleAdminApiSupport,
    handleCharacterPresentationPreview,
    handlePrShopSupport,
    handleRaidSupport,
    handleReceptionSupport,
    handleSquadSupport,
    startSiteApiServer,
};