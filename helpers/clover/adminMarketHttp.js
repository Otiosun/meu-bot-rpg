'use strict';

const {
    getMarketListing,
    listMarket,
} = require('./marketService');

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

function parseAdminMarketPath(pathname) {
    const path = String(pathname || '');
    if (path === '/admin/market') return { kind: 'list' };
    const detail = path.match(/^\/admin\/market\/([^/]+)$/);
    if (!detail) return null;
    let listingKey = detail[1];
    try { listingKey = decodeURIComponent(listingKey); } catch { /* service validates */ }
    return { kind: 'detail', listingKey: String(listingKey || '').trim() };
}

function requireCapability(access, capability) {
    if (access?.actor?.capabilities?.includes(capability)) return;
    const error = new Error('Seu perfil não possui permissão para consultar o Mercado.');
    error.code = 'missing_capability';
    error.status = 403;
    error.details = { capability };
    throw error;
}

function normalizeStatus(value) {
    const clean = String(value || '').trim().toLowerCase();
    if (!clean || clean === 'all') return null;
    return clean;
}

function includesQuery(listing, query) {
    if (!query) return true;
    const haystack = [
        listing.key,
        listing.title,
        listing.itemName,
        listing.sellerId,
        listing.seller?.name,
        listing.shopName,
        listing.status,
        listing.type,
    ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase('pt-BR');
    return haystack.includes(query.toLocaleLowerCase('pt-BR'));
}

async function handleAdminMarketHttp(req, res, options = {}, parsedPath = null) {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = parsedPath || parseAdminMarketPath(url.pathname);
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
        requireCapability(context.access, 'market.view');
        if (method !== 'GET') {
            const error = new Error('Método não permitido.');
            error.code = 'method_not_allowed';
            error.status = 405;
            throw error;
        }

        if (route.kind === 'detail') {
            const listing = await getMarketListing(context.db, route.listingKey);
            sendJson(res, 200, { ok: true, listing });
            return true;
        }

        const type = ['fixed', 'auction'].includes(url.searchParams.get('type'))
            ? url.searchParams.get('type')
            : undefined;
        const status = normalizeStatus(url.searchParams.get('status'));
        const query = String(url.searchParams.get('q') || '').trim();
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 100));
        const actorId = context.access?.actor?.id || context.access?.actor?.playerId || 'admin';

        let listings = await listMarket(context.db, actorId, {
            type,
            includeInactive: true,
            limit,
        });
        if (status) listings = listings.filter((listing) => String(listing.status || '').toLowerCase() === status);
        if (query) listings = listings.filter((listing) => includesQuery(listing, query));

        const counts = listings.reduce((acc, listing) => {
            const key = String(listing.status || 'unknown');
            acc[key] = Number(acc[key] || 0) + 1;
            return acc;
        }, {});

        sendJson(res, 200, {
            ok: true,
            listings,
            counts,
            total: listings.length,
            moderation: {
                cancelAction: 'market.listing.cancel',
                auctionWithBidCancellation: false,
            },
        });
        return true;
    } catch (error) {
        sendJson(res, Number(error?.status || 400), {
            ok: false,
            error: error?.code || 'admin_market_request_failed',
            message: error?.message || 'Não foi possível consultar o Mercado.',
            details: error?.details || null,
        });
        return true;
    }
}

module.exports = {
    handleAdminMarketHttp,
    parseAdminMarketPath,
};
