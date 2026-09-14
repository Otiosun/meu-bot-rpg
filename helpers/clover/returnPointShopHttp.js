'use strict';

const {
    authenticateReturnShopSession,
    loginWithReturnShopCode,
    revokeReturnShopSession,
} = require('./returnPointShopAuthService');
const {
    assertPreResetMutationAllowed,
    assertPreResetSurfaceAllowed,
} = require('./preResetAccessService');
const {
    ReturnPointShopError,
    getReturnPointShopDashboard,
    purchaseReturnPointShopItem,
} = require('./returnPointShopService');
const {
    ReturnPointShopGateError,
    assertReturnPointShopBuyerEligible,
    getReturnPointShopGateState,
} = require('./returnPointShopGateService');
const { ReturnPointsServiceError } = require('./returnPointsService');
const { PreResetFutureRollError } = require('./preResetFutureRollService');
const { PreResetFutureSlotError } = require('./preResetFutureSlotService');
const { routeDescriptor } = require('./httpRouteDescriptor');

const RETURN_SHOP_ROUTE_DEFINITIONS = Object.freeze([
    ['auth-login', 'POST', '/return-points/auth/login'],
    ['auth-logout', 'POST', '/return-points/auth/logout'],
    ['catalog', 'GET', '/return-points/shop'],
    ['purchase', 'POST', '/return-points/shop/purchase'],
]);
const RETURN_POINT_SHOP_ROUTE_DESCRIPTORS = Object.freeze(RETURN_SHOP_ROUTE_DEFINITIONS.map(([id, method, template]) => routeDescriptor({
    id: `prereset.return-shop.${id}`,
    methods: [method],
    template,
    samplePath: template,
    match: (pathname) => pathname === template,
    handlerOwner: 'handleReturnPointShopHttp',
    sourceFile: 'helpers/clover/returnPointShopHttp.js',
    visibility: 'INTERNAL_OPERATIONAL',
    authClass: id === 'auth-login' ? 'PUBLIC_AUTH_ENTRY' : 'SITE_SESSION:return_shop',
    contractId: 'internal-return-point-shop-v1',
})));
const RETURN_SHOP_PATHS = new Set(RETURN_POINT_SHOP_ROUTE_DESCRIPTORS.map((descriptor) => descriptor.template));

function setCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, X-Request-Id, ngrok-skip-browser-warning');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(payload));
}

function bearerToken(req) {
    const match = String(req.headers?.authorization || '').trim().match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

async function readJsonBody(req, maxBytes = 32 * 1024) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > maxBytes) throw Object.assign(new Error('JSON muito grande.'), { code: 'payload_too_large', status: 413 });
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('JSON inválido.'), { code: 'invalid_json', status: 400 }); }
}

function statusFor(error) {
    const notFound = new Set(['catalog_item_not_found', 'target_roll_not_found', 'player_not_found']);
    const forbidden = new Set([
        'prereset_mode_disabled', 'policy_disabled', 'policy_not_configured',
        'session_ineligible', 'ownership_denied', 'return_shop_closed',
        'return_shop_not_eligible',
    ]);
    const conflict = new Set([
        'manual_target_exclusive_conflict',
        'insufficient_return_points', 'idempotency_conflict', 'player_limit_reached',
        'global_stock_exhausted', 'weekly_limit_reached', 'future_slot_full',
        'target_roll_replaced_by_sacrifice', 'future_character_locked', 'roll_incompatible',
        'keep_player_cannot_roll', 'prereset_build_not_available', 'return_shop_snapshot_missing',
        'return_shop_target_already_purchased',
    ]);
    if (notFound.has(error?.code)) return 404;
    if (forbidden.has(error?.code)) return 403;
    if (conflict.has(error?.code)) return 409;
    if (error?.code === 'rate_limited') return 429;
    return Number(error?.status || 400);
}

async function requireSession(db, req, options = {}) {
    const authenticate = options.authenticateReturnShopSession
        || options.authenticateSession
        || authenticateReturnShopSession;
    const auth = await authenticate(db, bearerToken(req));
    if (!auth?.ok || !auth.player?.id) {
        throw Object.assign(new Error('Sessão da Loja de Retorno inválida ou expirada.'), { code: 'invalid_session', status: 401 });
    }
    if (auth.scope && auth.scope !== 'return_shop') {
        throw Object.assign(new Error('Esta sessão não pertence à Loja de Retorno.'), { code: 'invalid_session_scope', status: 401 });
    }
    return auth;
}

function publicAuthPlayer(player = {}) {
    const name = String(player.personagem_nome || player.nome || player.display_name || '').trim();
    return {
        id: player.id,
        name: name && name !== '-' ? name : null,
    };
}

async function handleReturnPointShopHttp(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    if (!RETURN_SHOP_PATHS.has(path)) return false;

    setCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }

    const descriptor = RETURN_POINT_SHOP_ROUTE_DESCRIPTORS.find((candidate) => candidate.match(path));
    if (!descriptor.methods.includes(method)) {
        sendJson(res, 405, { ok:false, error:'method_not_allowed' });
        return true;
    }

    const db = options.getDb?.();
    if (!db) {
        sendJson(res, 503, { ok:false, error:'database_unavailable', message:'Banco ainda não está pronto.' });
        return true;
    }

    try {
        if (path === '/return-points/auth/login') {
            const body = await readJsonBody(req);
            const login = options.loginWithReturnShopCode || loginWithReturnShopCode;
            const result = await login(db, { phone:body.phone, code:body.code });
            if (!result?.ok) {
                const status = result?.reason === 'rate_limited' ? 429 : 401;
                sendJson(res, status, {
                    ok:false,
                    error:result?.reason || 'invalid_credentials',
                    message:status === 429
                        ? 'Muitas tentativas. Aguarde antes de tentar novamente.'
                        : 'Número ou código inválido.',
                    retryAfterMs:result?.retryAfterMs || null,
                });
                return true;
            }
            sendJson(res, 200, {
                ok:true,
                scope:'return_shop',
                token:result.token,
                expiresAt:result.expiresAt,
                player:publicAuthPlayer(result.player),
            });
            return true;
        }

        if (path === '/return-points/auth/logout') {
            const revoke = options.revokeReturnShopSession || revokeReturnShopSession;
            await revoke(db, bearerToken(req));
            sendJson(res, 200, { ok:true });
            return true;
        }

        const auth = await requireSession(db, req, options);
        const accessContext = {
            env: options.env || process.env,
            policyRegistry: options.preResetPolicyRegistry,
            session: { playerId:auth.player.id, released:true },
        };
        if (method === 'GET') {
            assertPreResetSurfaceAllowed(accessContext);
            const [dashboard, shopGate] = await Promise.all([
                getReturnPointShopDashboard(db, auth.player.id),
                getReturnPointShopGateState(db),
            ]);
            sendJson(res, 200, { ...dashboard, shopGate });
            return true;
        }

        assertPreResetMutationAllowed({ ...accessContext, playerId:auth.player.id });
        await assertReturnPointShopBuyerEligible(db, auth.player.id);
        const body = await readJsonBody(req);
        const idempotencyKey = String(req.headers?.['idempotency-key'] || body.idempotencyKey || '').trim();
        if (!idempotencyKey) {
            sendJson(res, 400, { ok:false, error:'missing_idempotency_key', message:'A compra precisa de Idempotency-Key.' });
            return true;
        }
        const result = await purchaseReturnPointShopItem(db, auth.player.id, {
            itemKey:body.itemKey,
            targetRollNumber:body.targetRollNumber,
            quantity:body.quantity,
            idempotencyKey,
        });
        sendJson(res, result.duplicate ? 200 : 201, result);
        return true;
    } catch (error) {
        if (String(error?.message || '').includes('return_shop_not_eligible')) {
            error = new ReturnPointShopGateError(
                'return_shop_not_eligible',
                'Seu cadastro não pertence ao snapshot RESET autorizado quando a Loja de Retorno foi aberta.'
            );
        }
        const known = error instanceof ReturnPointShopError
            || error instanceof ReturnPointShopGateError
            || error instanceof ReturnPointsServiceError
            || error instanceof PreResetFutureRollError
            || error instanceof PreResetFutureSlotError
            || error?.code;
        if (!known) throw error;
        sendJson(res, statusFor(error), {
            ok:false,
            error:error.code || 'return_point_shop_failed',
            message:error.message || 'Não foi possível concluir a operação.',
            details:error.details || null,
        });
        return true;
    }
}

module.exports = {
    RETURN_POINT_SHOP_ROUTE_DESCRIPTORS,
    RETURN_SHOP_PATHS,
    handleReturnPointShopHttp,
    statusFor,
};
