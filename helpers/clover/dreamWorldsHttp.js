'use strict';

const { authenticateSiteSession } = require('./siteAuthService');
const { getAdminActorAccess } = require('./adminAccessService');
const { runEconomyMutationExclusive } = require('./economyMutationQueue');
const {
    DreamWorldsServiceError,
    approveDreamRequest,
    createDreamWorld,
    ensureDreamWorldsSchema,
    getPlayerDreamDashboard,
    getPublicDreamWorldBySlug,
    listPublicDreamWorlds,
    rejectDreamRequest,
    serializeRequest,
    serializeWorld,
    submitDreamRequest,
} = require('./dreamWorldsService');

function setDreamWorldsCors(req, res) {
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

async function readJsonBody(req, maxBytes = 128 * 1024) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > maxBytes) {
            const error = new Error('Corpo da requisição grande demais.');
            error.code = 'payload_too_large';
            error.status = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        const error = new Error('JSON inválido.');
        error.code = 'invalid_json';
        error.status = 400;
        throw error;
    }
}

function decodePathValue(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function parseDreamPath(pathname) {
    if (pathname === '/dream-worlds') return { kind: 'world-list' };
    if (pathname === '/dream-worlds/me') return { kind: 'dashboard' };
    const request = pathname.match(/^\/dream-worlds\/([^/]+)\/requests$/);
    if (request) return { kind: 'request-submit', world: decodePathValue(request[1]) };
    const detail = pathname.match(/^\/dream-worlds\/([^/]+)$/);
    if (detail) return { kind: 'world-detail', slug: decodePathValue(detail[1]) };
    return null;
}

function parseAdminDreamPath(pathname) {
    if (pathname === '/admin/dream-worlds') return { kind: 'admin-worlds' };
    if (pathname === '/admin/dream-worlds/requests') return { kind: 'admin-requests' };
    const action = pathname.match(/^\/admin\/dream-worlds\/requests\/(\d+)\/(approve|reject)$/);
    if (action) return { kind: `admin-request-${action[2]}`, requestId: Number(action[1]) };
    return null;
}

function hasCapability(access, capability) {
    return Boolean(access?.actor?.capabilities?.includes(capability));
}

function requireCapability(access, capability) {
    if (hasCapability(access, capability)) return;
    const error = new Error('Seu perfil não possui a permissão necessária.');
    error.code = 'missing_capability';
    error.status = 403;
    error.details = { capability };
    throw error;
}

async function requireSession(db, req) {
    const auth = await authenticateSiteSession(db, bearerToken(req));
    if (!auth?.ok || !auth.player?.id) {
        const error = new Error('Sessão inválida ou expirada.');
        error.code = auth?.reason || 'invalid_session';
        error.status = 401;
        throw error;
    }
    return auth;
}

async function requireAdmin(db, req, capabilities = []) {
    const auth = await requireSession(db, req);
    const access = await getAdminActorAccess(db, auth.player.id);
    if (!access?.ok) {
        const error = new Error('Sua conta não possui acesso à Central ADM.');
        error.code = access?.code || 'admin_access_denied';
        error.status = 403;
        throw error;
    }
    for (const capability of capabilities) requireCapability(access, capability);
    return { auth, access };
}

function dreamErrorStatus(error) {
    if (Number(error?.status)) return Number(error.status);
    const notFound = new Set(['world_not_found', 'request_not_found', 'squad_not_found']);
    const forbidden = new Set(['squad_buyer_forbidden', 'admin_access_denied', 'missing_capability']);
    const conflict = new Set([
        'active_request_exists',
        'idempotency_conflict',
        'world_not_available',
        'request_not_approvable',
        'request_not_rejectable',
    ]);
    if (notFound.has(error?.code)) return 404;
    if (forbidden.has(error?.code)) return 403;
    if (conflict.has(error?.code)) return 409;
    return 400;
}

async function listAdminWorlds(db, url) {
    await ensureDreamWorldsSchema(db);
    const status = String(url.searchParams.get('status') || '').trim().toLowerCase();
    const rows = status
        ? await db.all('SELECT * FROM clover_dream_worlds WHERE status = ? ORDER BY id DESC', [status])
        : await db.all('SELECT * FROM clover_dream_worlds ORDER BY id DESC');
    return rows.map(serializeWorld);
}

async function listAdminRequests(db, url) {
    await ensureDreamWorldsSchema(db);
    const status = String(url.searchParams.get('status') || '').trim().toLowerCase();
    const where = status ? 'WHERE request.status = ?' : '';
    const params = status ? [status] : [];
    const rows = await db.all(
        `SELECT request.*, world.name AS world_name, world.slug AS world_slug,
                world.status AS world_status, world.yulls_price AS world_yulls_price
         FROM clover_dream_requests request
         JOIN clover_dream_worlds world ON world.id = request.world_id
         ${where}
         ORDER BY request.id DESC`,
        params
    );
    return rows.map((row) => ({
        ...serializeRequest(row),
        world: {
            name: row.world_name,
            slug: row.world_slug,
            status: row.world_status,
            yullsPrice: Number(row.world_yulls_price || 0),
        },
    }));
}

async function handleDreamWorldsHttp(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const playerRoute = parseDreamPath(url.pathname);
    const adminRoute = parseAdminDreamPath(url.pathname);
    if (!playerRoute && !adminRoute) return false;

    setDreamWorldsCors(req, res);
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
            message: 'O banco ainda não está pronto.',
        });
        return true;
    }

    try {
        if (playerRoute?.kind === 'world-list') {
            if (method !== 'GET') {
                sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
                return true;
            }
            const worlds = await listPublicDreamWorlds(db, { status: url.searchParams.get('status') });
            res.setHeader('Cache-Control', 'public, max-age=30');
            sendJson(res, 200, { ok: true, worlds, dreamWorlds: worlds, data: worlds });
            return true;
        }

        if (playerRoute?.kind === 'world-detail') {
            if (method !== 'GET') {
                sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
                return true;
            }
            const world = await getPublicDreamWorldBySlug(db, playerRoute.slug);
            res.setHeader('Cache-Control', 'public, max-age=30');
            sendJson(res, 200, { ok: true, world, dreamWorld: world, data: world });
            return true;
        }

        if (playerRoute?.kind === 'dashboard') {
            if (method !== 'GET') {
                sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
                return true;
            }
            const auth = await requireSession(db, req);
            const dashboard = await getPlayerDreamDashboard(db, auth.player.id);
            sendJson(res, 200, { ok: true, dashboard, dreams: dashboard, data: dashboard });
            return true;
        }

        if (playerRoute?.kind === 'request-submit') {
            if (method !== 'POST') {
                sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
                return true;
            }
            const auth = await requireSession(db, req);
            const body = await readJsonBody(req);
            const idempotencyKey = String(
                req.headers['idempotency-key']
                || body.idempotencyKey
                || body.idempotency_key
                || ''
            ).trim();
            const result = await submitDreamRequest(db, auth.player.id, playerRoute.world, {
                buyerType: body.buyerType || body.buyer_type,
                buyerId: body.buyerId || body.buyer_id,
                paymentMethod: body.paymentMethod || body.payment_method,
                playerNote: body.playerNote || body.player_note,
                idempotencyKey,
                metadata: { ...(body.metadata || {}), via: 'site' },
            });
            sendJson(res, result.duplicate ? 200 : 201, { ok: true, ...result });
            return true;
        }

        if (adminRoute?.kind === 'admin-worlds') {
            const admin = await requireAdmin(db, req, method === 'POST' ? ['raid.manage'] : ['raid.view']);
            if (method === 'GET') {
                const worlds = await listAdminWorlds(db, url);
                sendJson(res, 200, { ok: true, worlds, data: worlds });
                return true;
            }
            if (method === 'POST') {
                const body = await readJsonBody(req);
                const world = await createDreamWorld(db, body, admin.auth.player.id);
                sendJson(res, 201, { ok: true, world, data: world });
                return true;
            }
            sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
            return true;
        }

        if (adminRoute?.kind === 'admin-requests') {
            if (method !== 'GET') {
                sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
                return true;
            }
            await requireAdmin(db, req, ['raid.view']);
            const requests = await listAdminRequests(db, url);
            sendJson(res, 200, { ok: true, requests, data: requests });
            return true;
        }

        if (adminRoute?.kind === 'admin-request-approve') {
            if (method !== 'POST') {
                sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
                return true;
            }
            const admin = await requireAdmin(db, req, ['raid.manage', 'resource.adjust']);
            const body = await readJsonBody(req);
            const result = await runEconomyMutationExclusive(
                () => approveDreamRequest(db, adminRoute.requestId, admin.auth.player.id, body),
                { operation: `site:dream-request-approve:${adminRoute.requestId}` }
            );
            sendJson(res, 200, { ok: true, ...result });
            return true;
        }

        if (adminRoute?.kind === 'admin-request-reject') {
            if (method !== 'POST') {
                sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
                return true;
            }
            const admin = await requireAdmin(db, req, ['raid.manage']);
            const body = await readJsonBody(req);
            const request = await rejectDreamRequest(db, adminRoute.requestId, admin.auth.player.id, body);
            sendJson(res, 200, { ok: true, request, data: request });
            return true;
        }

        return false;
    } catch (error) {
        const known = error instanceof DreamWorldsServiceError
            || error?.code
            || Number(error?.status);
        if (!known) throw error;
        sendJson(res, dreamErrorStatus(error), {
            ok: false,
            error: error?.code || 'dream_worlds_error',
            message: error?.message || 'Não foi possível concluir a operação.',
            details: error?.details || null,
        });
        return true;
    }
}

module.exports = {
    handleDreamWorldsHttp,
    parseAdminDreamPath,
    parseDreamPath,
};
