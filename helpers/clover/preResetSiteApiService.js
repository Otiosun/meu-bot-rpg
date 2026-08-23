'use strict';

const { authenticateSiteSession } = require('./siteAuthService');
const { runEconomyMutationExclusive } = require('./economyMutationQueue');
const { getIntegratedAccessContext, contextCanAnywhere } = require('./integratedAccessContextService');
const {
    DEFAULT_PRE_RESET_POLICY_REGISTRY,
    PreResetPolicyError,
    requireEnabledPolicy,
} = require('./preResetPolicyRegistryService');
const {
    PreResetAccessError,
    assertPreResetAdminMutationAllowed,
    assertPreResetMutationAllowed,
} = require('./preResetAccessService');
const {
    PreResetCharacterError,
    applyFutureCharacterMutation,
    getFutureCharacter,
    reviewFutureCharacter,
} = require('./preResetCharacterService');
const { getReturnPointsBalance, getReturnPointsLedger, ReturnPointsServiceError } = require('./returnPointsService');
const {
    ReturnPointConversionError,
    claimReturnPointConversion,
    previewReturnPointConversion,
    reconcileReturnPointConversions,
} = require('./returnPointConversionService');
const {
    PreResetShopError,
    getPreResetEntitlements,
    purchasePreResetEntitlement,
} = require('./preResetShopService');

const REVIEW_CAPABILITY = 'prereset.review';

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function cors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, X-Request-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
}

function bearerToken(req) {
    const match = String(req.headers?.authorization || '').trim().match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

function operationKey(req, body = {}) {
    return String(req.headers?.['idempotency-key'] || body.operationKey || body.idempotencyKey || '').trim();
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > maxBytes) throw Object.assign(new Error('JSON muito grande.'), { code: 'payload_too_large', status: 413 });
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(new Error('JSON invalido.'), { code: 'validation_failed', status: 400 }); }
}

function httpError(error) {
    if (error?.status && error?.code) return error;
    const receivedCode = error?.code || '';
    const forbidden = new Set(['ownership_denied', 'capability_denied', 'session_ineligible', 'prereset_mode_disabled', 'policy_disabled', 'policy_not_configured']);
    const conflict = new Set(['revision_conflict', 'idempotency_conflict', 'entitlement_already_owned', 'insufficient_return_points', 'conversion_source_changed']);
    const notFound = new Set(['player_not_found', 'catalog_item_not_found']);
    const validation = new Set(['invalid_draft', 'draft_incomplete', 'invalid_revision', 'invalid_operation_key', 'invalid_operation', 'invalid_catalog', 'catalog_disabled', 'invalid_argument', 'invalid_amount', 'character_not_editable', 'invalid_review_action', 'invalid_review_transition']);
    const code = [...forbidden, ...conflict, ...notFound, ...validation].includes(receivedCode) ? receivedCode : 'internal_error';
    return Object.assign(new Error(error?.message || 'Erro interno.'), {
        code,
        status: forbidden.has(code) ? 403 : conflict.has(code) ? 409 : notFound.has(code) ? 404 : code === 'internal_error' ? 500 : 400,
    });
}

async function requireSession(db, req) {
    const auth = await authenticateSiteSession(db, bearerToken(req));
    if (!auth.ok) throw Object.assign(new Error('Sessao invalida ou expirada.'), { code: 'unauthorized', status: 401 });
    return auth;
}

function rejectClientAuthority(body = {}, fields) {
    if (fields.some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
        throw Object.assign(new Error('A autoridade nao pode vir do cliente.'), { code: 'client_authority_forbidden', status: 400 });
    }
}

function registryFor(options) {
    return options.preResetPolicyRegistry || DEFAULT_PRE_RESET_POLICY_REGISTRY;
}

function runPreResetMutation(action) {
    // The Site API uses one SQLite connection. Serializing before service-level
    // BEGIN IMMEDIATE prevents nested transactions while retaining each
    // canonical service's own atomic transaction and idempotency checks.
    return runEconomyMutationExclusive(action, { operation: 'pre-reset-site-api' });
}

function sessionContext(auth) {
    return { playerId: auth.player.id, released: true };
}

function publicPolicy(registry) {
    const snapshot = registry.snapshot();
    return Object.fromEntries(Object.entries(snapshot).map(([key, policy]) => [key, {
        status: policy.status,
        enabled: policy.enabled,
        policyVersion: policy.policyVersion,
        testOnly: policy.testOnly === true,
    }]));
}

function assertPlayerMutation(auth, options) {
    return assertPreResetMutationAllowed({
        env: options.env || process.env,
        policyRegistry: registryFor(options),
        playerId: auth.player.id,
        session: sessionContext(auth),
    });
}

async function adminContext(db, auth, options) {
    assertPreResetAdminMutationAllowed({ env: options.env || process.env, policyRegistry: registryFor(options) });
    const access = await getIntegratedAccessContext(db, auth.player.id, options.accessOptions || {});
    if (!contextCanAnywhere(access, REVIEW_CAPABILITY)) {
        throw new PreResetAccessError('capability_denied', 'Capacidade administrativa insuficiente.');
    }
    return { actorId: auth.player.id, capabilities: [REVIEW_CAPABILITY], env: options.env || process.env, policyRegistry: registryFor(options) };
}

async function handlePreResetSiteApi(req, res, options = {}) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (!url.pathname.startsWith('/pre-reset')) return false;
    cors(req, res);
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') { res.statusCode = 204; res.end(); return true; }
    const db = options.getDb?.();
    if (!db) { sendJson(res, 503, { ok: false, error: 'database_unavailable' }); return true; }
    try {
        const auth = await requireSession(db, req);
        const registry = registryFor(options);
        const path = url.pathname;
        if (method === 'GET' && path === '/pre-reset/status') {
            const access = await getIntegratedAccessContext(db, auth.player.id, options.accessOptions || {});
            sendJson(res, 200, { ok: true, policy: publicPolicy(registry), capabilities: { canReview: contextCanAnywhere(access, REVIEW_CAPABILITY) } });
            return true;
        }
        if (method === 'GET' && path === '/pre-reset/future-character') {
            sendJson(res, 200, { ok: true, character: await getFutureCharacter(db, auth.player.id) }); return true;
        }
        if (method === 'GET' && path === '/pre-reset/return-points/balance') {
            sendJson(res, 200, { ok: true, balance: await getReturnPointsBalance(db, auth.player.id), ledger: await getReturnPointsLedger(db, auth.player.id) }); return true;
        }
        if (method === 'GET' && path === '/pre-reset/conversion') {
            const policy = registry.get('PH_RETURN_CONVERSION');
            sendJson(res, 200, { ok: true, conversion: await previewReturnPointConversion(db, auth.player.id, { policy }) }); return true;
        }
        if (method === 'GET' && path === '/pre-reset/shop/catalog') {
            const policy = registry.get('RESET_SHOP');
            sendJson(res, 200, { ok: true, status: policy.status, catalogVersion: policy.catalogVersion || null, items: policy.enabled ? policy.products : [] }); return true;
        }
        if (method === 'GET' && path === '/pre-reset/entitlements') {
            const purchases = await db.all('SELECT * FROM clover_prereset_purchases WHERE player_id = ? ORDER BY id ASC', [auth.player.id]);
            sendJson(res, 200, { ok: true, purchases, entitlements: await getPreResetEntitlements(db, auth.player.id) }); return true;
        }
        if ((method === 'POST' || method === 'PUT') && path === '/pre-reset/future-character') {
            const body = await readJsonBody(req); rejectClientAuthority(body, ['playerId', 'player_id', 'actorId', 'role', 'capabilities']); assertPlayerMutation(auth, options);
            const result = await runPreResetMutation(() => applyFutureCharacterMutation(db, auth.player.id, auth.player.id, {
                operationType: body.operationType || (body.expectedRevision === 0 ? 'create' : 'update'),
                operationKey: operationKey(req, body), expectedRevision: body.expectedRevision, draft: body.draft,
            }));
            sendJson(res, 200, { ok: true, ...result }); return true;
        }
        if (method === 'POST' && path === '/pre-reset/future-character/submit') {
            const body = await readJsonBody(req); rejectClientAuthority(body, ['playerId', 'player_id', 'actorId', 'role', 'capabilities']); assertPlayerMutation(auth, options);
            const result = await runPreResetMutation(() => applyFutureCharacterMutation(db, auth.player.id, auth.player.id, { operationType: 'submit', operationKey: operationKey(req, body), expectedRevision: body.expectedRevision, draft: body.draft }));
            sendJson(res, 200, { ok: true, ...result }); return true;
        }
        if (method === 'POST' && path === '/pre-reset/conversion/claim') {
            const body = await readJsonBody(req); rejectClientAuthority(body, ['playerId', 'player_id', 'balance', 'amount', 'role']); assertPlayerMutation(auth, options);
            const policy = requireEnabledPolicy(registry, 'PH_RETURN_CONVERSION');
            sendJson(res, 200, { ok: true, conversion: await runPreResetMutation(() => claimReturnPointConversion(db, auth.player.id, { policy, actorId: auth.player.id })) }); return true;
        }
        if (method === 'POST' && path === '/pre-reset/shop/purchase') {
            const body = await readJsonBody(req); rejectClientAuthority(body, ['playerId', 'player_id', 'actorId', 'price', 'priceReturnPoints', 'balance', 'entitlementKey', 'role']); assertPlayerMutation(auth, options);
            const policy = requireEnabledPolicy(registry, 'RESET_SHOP');
            const purchase = await runPreResetMutation(() => purchasePreResetEntitlement(db, auth.player.id, { itemKey: body.itemKey, idempotencyKey: operationKey(req, body), actorId: auth.player.id }, { catalog: policy.products }));
            sendJson(res, 200, { ok: true, ...purchase }); return true;
        }
        const review = path.match(/^\/pre-reset\/admin\/future-characters\/([^/]+)\/review$/);
        if (method === 'POST' && review) {
            const body = await readJsonBody(req); rejectClientAuthority(body, ['actorId', 'role', 'capabilities']);
            const context = await adminContext(db, auth, options);
            const result = await runPreResetMutation(() => reviewFutureCharacter(db, context, { playerId: decodeURIComponent(review[1]), action: body.action, reason: body.reason, expectedRevision: body.expectedRevision, operationKey: operationKey(req, body) }));
            sendJson(res, 200, { ok: true, ...result }); return true;
        }
        sendJson(res, 404, { ok: false, error: 'not_found' }); return true;
    } catch (error) {
        const safe = httpError(error);
        sendJson(res, safe.status, { ok: false, error: safe.code, message: safe.message });
        return true;
    }
}

module.exports = { REVIEW_CAPABILITY, handlePreResetSiteApi, publicPolicy };
