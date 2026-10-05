'use strict';

const { getRaidCategoryCatalog } = require('./raidCategoryCatalog');
const {
    getRaidCreationOptions,
    previewRaidMonthlyUsage,
} = require('./raidV2OptionsService');
const { raidMutationStatus } = require('./raidIdempotentHttp');
const { authenticateSiteSession } = require('./siteAuthService');
const { matchDescriptor, routeDescriptor } = require('./httpRouteDescriptor');

const RAID_V2_OPTIONS_ROUTES = Object.freeze([
    routeDescriptor({
        id: 'raid.categories.read',
        methods: ['GET'],
        template: '/raids/categories',
        samplePath: '/raids/categories',
        match: (pathname) => pathname === '/raids/categories',
        handlerOwner: 'handleRaidV2OptionsHttp',
        sourceFile: 'helpers/clover/raidV2OptionsHttp.js',
        authClass: 'PUBLIC_SAFE',
        contractId: 'raid-categories-v2',
    }),
    routeDescriptor({
        id: 'raid.options.read',
        methods: ['GET'],
        template: '/raids/options',
        samplePath: '/raids/options',
        match: (pathname) => pathname === '/raids/options',
        handlerOwner: 'handleRaidV2OptionsHttp',
        sourceFile: 'helpers/clover/raidV2OptionsHttp.js',
        authClass: 'SITE_SESSION',
        contractId: 'raid-options-v2',
    }),
    routeDescriptor({
        id: 'raid.usage.preview',
        methods: ['GET'],
        template: '/raids/usage',
        samplePath: '/raids/usage?category=saga_pessoal&scopePlayerId=example',
        match: (pathname) => pathname === '/raids/usage',
        handlerOwner: 'handleRaidV2OptionsHttp',
        sourceFile: 'helpers/clover/raidV2OptionsHttp.js',
        authClass: 'SITE_SESSION',
        contractId: 'raid-usage-preview-v2',
    }),
]);

function setCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Request-Id, ngrok-skip-browser-warning'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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

function usageInput(url) {
    return {
        category: String(url.searchParams.get('category') || '').trim(),
        scopePlayerId: String(url.searchParams.get('scopePlayerId') || '').trim() || undefined,
        scopeSquadKey: String(url.searchParams.get('scopeSquadKey') || '').trim() || undefined,
        referenceDate: String(url.searchParams.get('referenceDate') || '').trim() || undefined,
    };
}

async function handleRaidV2OptionsHttp(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const descriptor = matchDescriptor(RAID_V2_OPTIONS_ROUTES, method, url.pathname);
    const knownPath = RAID_V2_OPTIONS_ROUTES.some((route) => route.match(url.pathname));

    if (!knownPath) return false;
    if (method !== 'OPTIONS' && !descriptor) return false;

    setCors(req, res);
    res.setHeader('Cache-Control', url.pathname === '/raids/categories'
        ? 'public, max-age=300'
        : 'private, no-store, max-age=0');

    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }

    try {
        if (url.pathname === '/raids/categories') {
            const getCategories = options.getRaidCategoryCatalog || getRaidCategoryCatalog;
            sendJson(res, 200, { ok: true, categories: getCategories() });
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

        if (url.pathname === '/raids/options') {
            const getOptions = options.getRaidCreationOptions || getRaidCreationOptions;
            const creationOptions = await getOptions(db, auth.player.id);
            sendJson(res, 200, { ok: true, options: creationOptions });
            return true;
        }

        const previewUsage = options.previewRaidMonthlyUsage || previewRaidMonthlyUsage;
        const preview = await previewUsage(db, auth.player.id, usageInput(url));
        sendJson(res, 200, { ok: true, preview });
        return true;
    } catch (error) {
        sendJson(res, raidMutationStatus(error), {
            ok: false,
            error: error?.code || 'raid_read_failed',
            message: error?.message || 'Não foi possível consultar os dados da Raid.',
            details: error?.details || null,
        });
        return true;
    }
}

module.exports = {
    RAID_V2_OPTIONS_ROUTES,
    bearerToken,
    handleRaidV2OptionsHttp,
    usageInput,
};
