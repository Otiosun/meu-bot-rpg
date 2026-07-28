'use strict';

const { getAdminActorAccess } = require('./adminAccessService');
const {
    getRewardPackage,
    listRewardGrants,
    listRewardPackages,
} = require('./adminRewardService');
const { authenticateSiteSession } = require('./siteAuthService');

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

function parseRewardDetailPath(pathname) {
    const match = String(pathname || '').match(/^\/admin\/rewards\/([^/]+)$/);
    if (!match || match[1] === 'grants') return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
}

function isAdminRewardsPath(pathname) {
    return pathname === '/admin/rewards'
        || pathname === '/admin/rewards/grants'
        || Boolean(parseRewardDetailPath(pathname));
}

function enabled(value) {
    return TRUE_VALUES.has(String(value || '').trim().toLowerCase());
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
    return { db, actor: access.actor };
}

async function handleAdminRewardsReadApi(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    if (!isAdminRewardsPath(url.pathname)) return false;

    setAdminCors(req, res);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
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

        if (url.pathname === '/admin/rewards/grants') {
            const listGrants = options.listGrants || listRewardGrants;
            const result = await listGrants(context.db, {
                playerId: url.searchParams.get('playerId') || undefined,
                packageId: url.searchParams.get('packageId') || undefined,
                status: url.searchParams.get('status') || undefined,
                limit: url.searchParams.get('limit') || undefined,
            });
            sendJson(res, 200, result);
            return true;
        }

        const packageId = parseRewardDetailPath(url.pathname);
        if (packageId) {
            const getPackage = options.getPackage || getRewardPackage;
            const rewardPackage = await getPackage(context.db, packageId, { nullIfMissing: true });
            if (!rewardPackage) {
                const error = new Error('Pacote de recompensa não encontrado.');
                error.code = 'reward_package_not_found';
                error.status = 404;
                throw error;
            }
            sendJson(res, 200, { ok: true, package: rewardPackage });
            return true;
        }

        const listPackages = options.listPackages || listRewardPackages;
        const result = await listPackages(context.db, {
            includeArchived: enabled(url.searchParams.get('archived')),
            query: url.searchParams.get('q') || '',
            limit: url.searchParams.get('limit') || undefined,
        });
        sendJson(res, 200, result);
        return true;
    } catch (error) {
        sendJson(res, Number(error?.status || 400), {
            ok: false,
            error: error?.code || 'admin_rewards_request_failed',
            message: error?.message || 'Não foi possível consultar as recompensas.',
            details: error?.details || null,
        });
        return true;
    }
}

module.exports = {
    handleAdminRewardsReadApi,
    isAdminRewardsPath,
    parseRewardDetailPath,
};
