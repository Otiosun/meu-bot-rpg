'use strict';

const { authenticateSiteSession } = require('./siteAuthService');
const { runOperationKernel } = require('./operationKernelService');
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
const INTERNAL_ERROR_MESSAGE = 'Nao foi possivel concluir a operacao. Tente novamente mais tarde.';
const PUBLIC_ERROR_MESSAGES = Object.freeze({
    unauthorized: 'Sessao invalida ou expirada.',
    ownership_denied: 'A sessao nao pode alterar esse recurso.',
    capability_denied: 'Capacidade administrativa insuficiente.',
    session_ineligible: 'A sessao nao esta elegivel para esta operacao.',
    prereset_mode_disabled: 'O modo pre-reset esta desativado.',
    policy_disabled: 'A politica necessaria esta desativada.',
    policy_not_configured: 'A politica necessaria ainda nao foi configurada.',
    revision_conflict: 'O recurso foi alterado por outra operacao.',
    idempotency_conflict: 'A chave de idempotencia ja pertence a outro pedido.',
    entitlement_already_owned: 'Esse direito futuro ja foi adquirido.',
    insufficient_return_points: 'Saldo de Pontos de Retorno insuficiente.',
    conversion_source_changed: 'A fonte da conversao mudou apos o primeiro claim.',
    player_not_found: 'Player nao encontrado.',
    catalog_item_not_found: 'Opcao pre-reset indisponivel.',
    client_authority_forbidden: 'A autoridade nao pode vir do cliente.',
    validation_failed: 'Pedido invalido.',
    payload_too_large: 'JSON muito grande.',
    invalid_draft: 'Rascunho invalido.',
    draft_incomplete: 'O rascunho futuro esta incompleto.',
    invalid_revision: 'Revisao invalida.',
    invalid_operation_key: 'Chave de operacao invalida.',
    invalid_operation: 'Operacao invalida.',
    invalid_catalog: 'Catalogo invalido.',
    catalog_disabled: 'O catalogo pre-reset ainda nao esta publicado.',
    invalid_argument: 'Argumento invalido.',
    invalid_amount: 'Valor invalido.',
    character_not_editable: 'O rascunho futuro nao esta editavel.',
    invalid_review_action: 'Acao de revisao invalida.',
    invalid_review_transition: 'Transicao de revisao invalida.',
});

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
    const receivedCode = error?.code || '';
    const forbidden = new Set(['ownership_denied', 'capability_denied', 'session_ineligible', 'prereset_mode_disabled', 'policy_disabled', 'policy_not_configured']);
    const conflict = new Set(['revision_conflict', 'idempotency_conflict', 'entitlement_already_owned', 'insufficient_return_points', 'conversion_source_changed']);
    const notFound = new Set(['player_not_found', 'catalog_item_not_found']);
    const validation = new Set(['invalid_draft', 'draft_incomplete', 'invalid_revision', 'invalid_operation_key', 'invalid_operation', 'invalid_catalog', 'catalog_disabled', 'invalid_argument', 'invalid_amount', 'character_not_editable', 'invalid_review_action', 'invalid_review_transition']);
    const known = [...forbidden, ...conflict, ...notFound, ...validation, 'unauthorized', 'client_authority_forbidden', 'payload_too_large', 'validation_failed'];
    const code = known.includes(receivedCode) ? receivedCode : 'internal_error';
    const explicitStatus = Number(error?.status);
    const status = code === 'internal_error'
        ? 500
        : Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus < 500
            ? explicitStatus
            : forbidden.has(code) ? 403 : conflict.has(code) ? 409 : notFound.has(code) ? 404 : 400;
    return Object.freeze({
        code,
        status,
        message: code === 'internal_error' ? INTERNAL_ERROR_MESSAGE : (PUBLIC_ERROR_MESSAGES[code] || 'Pedido invalido.'),
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

function sessionContext(auth) {
    return { playerId: auth.player.id, released: true };
}

function canonicalSiteActor(auth) {
    return Object.freeze({
        authenticated: true,
        playerId: String(auth.player.id),
        session: Object.freeze(sessionContext(auth)),
    });
}

function runPreResetOperation({ actor, operation, authorize, validate, mutate }) {
    return runOperationKernel({ actor, operation: `pre-reset:${operation}`, authorize, validate, mutate });
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

function serializeFutureCharacter(character) {
    if (!character) return null;
    return {
        status: character.status,
        revision: character.revision,
        draft: character.draft,
        createdAt: character.createdAt,
        updatedAt: character.updatedAt,
        submittedAt: character.submittedAt,
        approvedAt: character.approvedAt,
        lockedAt: character.lockedAt,
    };
}

function serializeReturnPointsEntry(entry = {}) {
    return {
        amount: Number(entry.amount),
        entryKind: entry.entry_kind,
        source: entry.source,
        reason: entry.reason,
        policyVersion: entry.policy_version || null,
        resetCycleKey: entry.reset_cycle_key || null,
        createdAt: entry.created_at,
    };
}

function serializeConversion(conversion = {}) {
    return {
        enabled: conversion.enabled === true,
        status: conversion.status,
        policyVersion: conversion.policyVersion || null,
        resetCycleKey: conversion.resetCycleKey || null,
        calculatedReturnPoints: Number(conversion.calculatedReturnPoints || 0),
        sourcePh: conversion.sourcePh ? {
            available: Number(conversion.sourcePh.available || 0),
            entryCount: Number(conversion.sourcePh.entryCount || 0),
        } : null,
        claimed: conversion.claimed === true,
        duplicate: conversion.duplicate === true,
    };
}

function serializeCatalogItem(item = {}) {
    return {
        itemKey: item.itemKey,
        entitlementKey: item.entitlementKey,
        priceReturnPoints: Number(item.priceReturnPoints),
    };
}

function serializePurchase(purchase = {}) {
    return {
        catalogItemKey: purchase.catalog_item_key,
        entitlementKey: purchase.entitlement_key,
        priceReturnPoints: Number(purchase.price_return_points),
        status: purchase.status,
        createdAt: purchase.created_at,
        refundedAt: purchase.refunded_at || null,
    };
}

function serializeEntitlement(entitlement = {}) {
    return {
        entitlementKey: entitlement.entitlement_key,
        status: entitlement.status,
        grantedAt: entitlement.granted_at,
        revokedAt: entitlement.revoked_at || null,
    };
}

function assertPlayerMutation(actor, options) {
    return assertPreResetMutationAllowed({
        env: options.env || process.env,
        policyRegistry: registryFor(options),
        playerId: actor.playerId,
        session: actor.session,
    });
}

async function adminContext(db, actor, options) {
    assertPreResetAdminMutationAllowed({ env: options.env || process.env, policyRegistry: registryFor(options) });
    const access = await getIntegratedAccessContext(db, actor.playerId, options.accessOptions || {});
    if (!contextCanAnywhere(access, REVIEW_CAPABILITY)) {
        throw new PreResetAccessError('capability_denied', 'Capacidade administrativa insuficiente.');
    }
    return { actorId: actor.playerId, capabilities: [REVIEW_CAPABILITY], env: options.env || process.env, policyRegistry: registryFor(options) };
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
        const actor = canonicalSiteActor(auth);
        const registry = registryFor(options);
        const path = url.pathname;
        if (method === 'GET' && path === '/pre-reset/status') {
            const access = await getIntegratedAccessContext(db, auth.player.id, options.accessOptions || {});
            sendJson(res, 200, { ok: true, policy: publicPolicy(registry), capabilities: { canReview: contextCanAnywhere(access, REVIEW_CAPABILITY) } });
            return true;
        }
        if (method === 'GET' && path === '/pre-reset/future-character') {
            sendJson(res, 200, { ok: true, character: serializeFutureCharacter(await getFutureCharacter(db, auth.player.id)) }); return true;
        }
        if (method === 'GET' && path === '/pre-reset/return-points/balance') {
            sendJson(res, 200, { ok: true, balance: await getReturnPointsBalance(db, auth.player.id), ledger: (await getReturnPointsLedger(db, auth.player.id)).map(serializeReturnPointsEntry) }); return true;
        }
        if (method === 'GET' && path === '/pre-reset/conversion') {
            const policy = registry.get('PH_RETURN_CONVERSION');
            sendJson(res, 200, { ok: true, conversion: serializeConversion(await previewReturnPointConversion(db, auth.player.id, { policy })) }); return true;
        }
        if (method === 'GET' && path === '/pre-reset/shop/catalog') {
            const policy = registry.get('RESET_SHOP');
            sendJson(res, 200, { ok: true, status: policy.status, catalogVersion: policy.catalogVersion || null, items: policy.enabled ? policy.products.map(serializeCatalogItem) : [] }); return true;
        }
        if (method === 'GET' && path === '/pre-reset/entitlements') {
            const purchases = await db.all('SELECT * FROM clover_prereset_purchases WHERE player_id = ? ORDER BY id ASC', [auth.player.id]);
            sendJson(res, 200, { ok: true, purchases: purchases.map(serializePurchase), entitlements: (await getPreResetEntitlements(db, auth.player.id)).map(serializeEntitlement) }); return true;
        }
        if ((method === 'POST' || method === 'PUT') && path === '/pre-reset/future-character') {
            const body = await readJsonBody(req);
            const result = await runPreResetOperation({ actor, operation: 'future-character',
                authorize: () => assertPlayerMutation(actor, options),
                validate: () => rejectClientAuthority(body, ['playerId', 'player_id', 'actorId', 'role', 'capabilities']),
                mutate: () => applyFutureCharacterMutation(db, actor.playerId, actor.playerId, {
                    operationType: body.operationType || (body.expectedRevision === 0 ? 'create' : 'update'), operationKey: operationKey(req, body), expectedRevision: body.expectedRevision, draft: body.draft,
                }),
            });
            sendJson(res, 200, { ok: true, duplicate: result.duplicate === true, character: serializeFutureCharacter(result.character) }); return true;
        }
        if (method === 'POST' && path === '/pre-reset/future-character/submit') {
            const body = await readJsonBody(req);
            const result = await runPreResetOperation({ actor, operation: 'future-character-submit',
                authorize: () => assertPlayerMutation(actor, options),
                validate: () => rejectClientAuthority(body, ['playerId', 'player_id', 'actorId', 'role', 'capabilities']),
                mutate: () => applyFutureCharacterMutation(db, actor.playerId, actor.playerId, { operationType: 'submit', operationKey: operationKey(req, body), expectedRevision: body.expectedRevision, draft: body.draft }),
            });
            sendJson(res, 200, { ok: true, duplicate: result.duplicate === true, character: serializeFutureCharacter(result.character) }); return true;
        }
        if (method === 'POST' && path === '/pre-reset/conversion/claim') {
            const body = await readJsonBody(req);
            const policy = requireEnabledPolicy(registry, 'PH_RETURN_CONVERSION');
            const conversion = await runPreResetOperation({ actor, operation: 'conversion-claim',
                authorize: () => assertPlayerMutation(actor, options),
                validate: () => rejectClientAuthority(body, ['playerId', 'player_id', 'balance', 'amount', 'role']),
                mutate: () => claimReturnPointConversion(db, actor.playerId, { policy, actorId: actor.playerId }),
            });
            sendJson(res, 200, { ok: true, conversion: serializeConversion(conversion) }); return true;
        }
        if (method === 'POST' && path === '/pre-reset/shop/purchase') {
            const body = await readJsonBody(req);
            const policy = requireEnabledPolicy(registry, 'RESET_SHOP');
            const purchase = await runPreResetOperation({ actor, operation: 'shop-purchase',
                authorize: () => assertPlayerMutation(actor, options),
                validate: () => rejectClientAuthority(body, ['playerId', 'player_id', 'actorId', 'price', 'priceReturnPoints', 'balance', 'entitlementKey', 'role']),
                mutate: () => purchasePreResetEntitlement(db, actor.playerId, { itemKey: body.itemKey, idempotencyKey: operationKey(req, body), actorId: actor.playerId }, { catalog: policy.products }),
            });
            sendJson(res, 200, { ok: true, duplicate: purchase.duplicate === true, purchase: serializePurchase(purchase.purchase), entitlement: serializeEntitlement(purchase.entitlement), balanceAfter: Number(purchase.balanceAfter) }); return true;
        }
        const review = path.match(/^\/pre-reset\/admin\/future-characters\/([^/]+)\/review$/);
        if (method === 'POST' && review) {
            const body = await readJsonBody(req);
            let context;
            const result = await runPreResetOperation({ actor, operation: 'admin-review',
                authorize: async () => { context = await adminContext(db, actor, options); },
                validate: () => rejectClientAuthority(body, ['actorId', 'role', 'capabilities']),
                mutate: () => reviewFutureCharacter(db, context, { playerId: decodeURIComponent(review[1]), action: body.action, reason: body.reason, expectedRevision: body.expectedRevision, operationKey: operationKey(req, body) }),
            });
            sendJson(res, 200, { ok: true, duplicate: result.duplicate === true, character: serializeFutureCharacter(result.character) }); return true;
        }
        sendJson(res, 404, { ok: false, error: 'not_found' }); return true;
    } catch (error) {
        const safe = httpError(error);
        sendJson(res, safe.status, { ok: false, error: safe.code, message: safe.message });
        return true;
    }
}

module.exports = {
    INTERNAL_ERROR_MESSAGE,
    REVIEW_CAPABILITY,
    handlePreResetSiteApi,
    httpError,
    publicPolicy,
    canonicalSiteActor,
    runPreResetOperation,
    serializeCatalogItem,
    serializeConversion,
    serializeEntitlement,
    serializeFutureCharacter,
    serializePurchase,
    serializeReturnPointsEntry,
};
