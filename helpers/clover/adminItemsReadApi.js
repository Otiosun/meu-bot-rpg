'use strict';

const { getAdminActorAccess } = require('./adminAccessService');
const { serializeTemplateRow } = require('./inventoryService');
const { authenticateSiteSession } = require('./siteAuthService');
const { matchDescriptor, routeDescriptor } = require('./httpRouteDescriptor');

const TRUE_VALUES = new Set(['1', 'true', 'yes']);

function setAdminCors(req, res) {
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
    const match = String(req.headers?.authorization || '').trim().match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

function parseItemDetailPath(pathname) {
    const match = String(pathname || '').match(/^\/admin\/items\/([^/]+)$/);
    if (!match) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
}

const ADMIN_ITEMS_ROUTE_DESCRIPTORS = Object.freeze([
    routeDescriptor({ id: 'admin.items.list', methods: ['GET'], template: '/admin/items', samplePath: '/admin/items', match: (p) => p === '/admin/items', handlerOwner: 'handleAdminItemsReadApi', sourceFile: 'helpers/clover/adminItemsReadApi.js', authClass: 'ADMIN_CAPABILITY:catalog.view', contractId: 'admin-item-list-v1' }),
    routeDescriptor({ id: 'admin.items.detail', methods: ['GET'], template: '/admin/items/:templateKey', samplePath: '/admin/items/example-item', match: (p) => Boolean(parseItemDetailPath(p)), handlerOwner: 'handleAdminItemsReadApi', sourceFile: 'helpers/clover/adminItemsReadApi.js', authClass: 'ADMIN_CAPABILITY:catalog.view', contractId: 'admin-item-v1' }),
]);
function isAdminItemsPath(pathname) { return ADMIN_ITEMS_ROUTE_DESCRIPTORS.some((route) => route.match(pathname)); }

function normalizeLimit(value, fallback = 100) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(1, Math.min(300, Math.floor(number)));
}

function enabled(value) {
    return TRUE_VALUES.has(String(value || '').trim().toLowerCase());
}

async function listItemTemplatesReadOnly(db, options = {}) {
    const conditions = [];
    const params = [];
    if (!options.includeArchived) conditions.push('active = 1');
    if (options.customOnly) conditions.push('is_custom = 1');
    const query = String(options.query || '').trim().toLowerCase();
    if (query) {
        const pattern = `%${query}%`;
        conditions.push(`(
            LOWER(COALESCE(template_key, '')) LIKE ?
            OR LOWER(COALESCE(item_name, '')) LIKE ?
            OR LOWER(COALESCE(description, '')) LIKE ?
            OR LOWER(COALESCE(category, '')) LIKE ?
            OR LOWER(COALESCE(kind, '')) LIKE ?
            OR LOWER(COALESCE(origin, '')) LIKE ?
        )`);
        params.push(pattern, pattern, pattern, pattern, pattern, pattern);
    }
    params.push(normalizeLimit(options.limit));
    const rows = await db.all(
        `SELECT * FROM clover_item_templates
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY is_custom DESC, updated_at DESC, item_name ASC
         LIMIT ?`,
        params
    );
    return (rows || []).map(serializeTemplateRow);
}

async function getItemTemplateReadOnly(db, templateKey) {
    const key = String(templateKey || '').trim();
    if (!key) return null;
    const row = await db.get(
        'SELECT * FROM clover_item_templates WHERE template_key = ? COLLATE NOCASE',
        [key]
    );
    return serializeTemplateRow(row);
}

async function resolveContext(req, res, options) {
    const db = options.getDb?.();
    if (!db) {
        sendJson(res, 503, {
            ok: false,
            error: 'database_unavailable',
            message: 'O banco ainda não está pronto.',
        });
        return null;
    }
    const authenticate = options.authenticateSession
        || ((database, request) => authenticateSiteSession(database, bearerToken(request)));
    const auth = await authenticate(db, req);
    if (!auth?.ok || !auth.player?.id) {
        sendJson(res, 401, {
            ok: false,
            error: auth?.reason || 'invalid_session',
            message: 'Sessão inválida ou expirada.',
        });
        return null;
    }
    const accessResolver = options.accessResolver || getAdminActorAccess;
    const access = await accessResolver(db, auth.player.id, options.accessOptions || {});
    if (!access?.ok) {
        sendJson(res, 403, {
            ok: false,
            error: access?.code || 'admin_access_denied',
            message: 'Sua conta não possui acesso à Central ADM.',
        });
        return null;
    }
    if (!access.actor?.capabilities?.includes('catalog.view')) {
        sendJson(res, 403, {
            ok: false,
            error: 'missing_capability',
            message: 'Seu perfil não possui a permissão necessária.',
            details: { capability: 'catalog.view' },
        });
        return null;
    }
    return { db };
}

async function handleAdminItemsReadApi(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    if (!matchDescriptor(ADMIN_ITEMS_ROUTE_DESCRIPTORS, method, url.pathname) && !isAdminItemsPath(url.pathname)) return false;

    setAdminCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }

    const context = await resolveContext(req, res, options);
    if (!context) return true;

    try {
        if (method !== 'GET') {
            const error = new Error('Método não permitido para esta rota administrativa.');
            error.code = 'method_not_allowed';
            error.status = 405;
            throw error;
        }

        const itemKey = parseItemDetailPath(url.pathname);
        if (itemKey) {
            const getItem = options.getItem || getItemTemplateReadOnly;
            const item = await getItem(context.db, itemKey);
            if (!item) {
                const error = new Error('Modelo de item não encontrado.');
                error.code = 'item_template_not_found';
                error.status = 404;
                throw error;
            }
            sendJson(res, 200, { ok: true, item });
            return true;
        }

        const listItems = options.listItems || listItemTemplatesReadOnly;
        const items = await listItems(context.db, {
            includeArchived: enabled(url.searchParams.get('archived')),
            customOnly: enabled(url.searchParams.get('custom')),
            query: url.searchParams.get('q') || '',
            limit: url.searchParams.get('limit') || undefined,
        });
        sendJson(res, 200, { ok: true, items });
        return true;
    } catch (error) {
        sendJson(res, Number(error?.status || 400), {
            ok: false,
            error: error?.code || 'admin_items_request_failed',
            message: error?.message || 'Não foi possível consultar o catálogo de itens.',
            details: error?.details || null,
        });
        return true;
    }
}

module.exports = {
    ADMIN_ITEMS_ROUTE_DESCRIPTORS,
    getItemTemplateReadOnly,
    handleAdminItemsReadApi,
    isAdminItemsPath,
    listItemTemplatesReadOnly,
    normalizeLimit,
    parseItemDetailPath,
};
