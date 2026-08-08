'use strict';

const base = require('./adminApiSupportBase');
const { commandCenterPath, handleAdminCommandCenterHttp } = require('./adminCommandCenterHttp');
const { handleCanonicalAdminTeamHttp, parseCanonicalAdminTeamPath } = require('./canonicalAdminTeamHttp');
const { requiredCapabilitiesForActions } = require('./adminOperationContract');
const { EXECUTION_POLICIES } = require('./adminOperationPolicy');
const { getOperationByCode } = require('./adminOperationService');
const { ATOMIC_SAFE_ACTION_TYPES, getAdminOperationExecutors } = require('./adminOperationRegistry');
const { acceptPartialAdminOperation, compensateAdminOperation, retryAdminOperation } = require('./adminOperationRecoveryService');
const { ensureInventoryV1, serializeTemplateRow } = require('./inventoryService');
const { handleAdminInventoryInstanceHttp, parseAdminInventoryPath } = require('./adminInventoryInstanceHttp');

function setRecoveryCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, X-Request-Id, ngrok-skip-browser-warning');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
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

function requireActionCapabilities(access, actions) {
    const required = requiredCapabilitiesForActions(Array.isArray(actions) ? actions : []);
    const missing = required.filter((capability) => !hasCapability(access, capability));
    if (!missing.length) return;
    const error = new Error('Seu perfil não pode recuperar todas as ações desta operação.');
    error.code = 'forbidden_actions';
    error.status = 403;
    error.details = { missing };
    throw error;
}

function parseRecoveryOperationPath(pathname) {
    const match = String(pathname || '').match(/^\/admin\/operations\/(OP-[A-F0-9]{6})\/(retry|compensate|accept-partial)$/i);
    if (!match) return null;
    return { code: match[1].toUpperCase(), command: match[2].toLowerCase() };
}

function parseOperationPath(pathname) {
    return parseRecoveryOperationPath(pathname) || base.parseOperationPath(pathname);
}

function parseAdminItemPath(pathname) {
    if (pathname === '/admin/items') return { list: true, templateKey: null };
    const match = String(pathname || '').match(/^\/admin\/items\/([^/]+)$/);
    if (!match) return null;
    let templateKey = match[1];
    try { templateKey = decodeURIComponent(templateKey); } catch { /* consulta falha fechada */ }
    return { list: false, templateKey };
}

function isRecognizedAdminPath(url) {
    return Boolean(
        commandCenterPath(url?.pathname)
        || parseCanonicalAdminTeamPath(url?.pathname)
        || parseRecoveryOperationPath(url?.pathname)
        || parseAdminItemPath(url?.pathname)
        || parseAdminInventoryPath(url?.pathname)
    ) || base.isRecognizedAdminPath(url);
}

function methodNotAllowed() {
    const error = new Error('Método não permitido para esta rota administrativa.');
    error.code = 'method_not_allowed';
    error.status = 405;
    return error;
}

async function handleRecoveryOperation(req, res, options, recoveryPath) {
    const method = String(req.method || 'GET').toUpperCase();
    setRecoveryCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }
    const context = await base.resolveAdminContext(req, res, options);
    if (!context) return true;
    try {
        if (method !== 'POST') throw methodNotAllowed();
        const { db, access } = context;
        const actor = { id: access.actor.id, role: access.actor.role };
        const body = await base.readJsonBody(req);
        const getOperation = options.operationGet || getOperationByCode;
        const operation = await getOperation(db, recoveryPath.code, { includeEvents: true, includeUnits: true });
        requireActionCapabilities(access, operation.actions);
        const executors = options.executors || getAdminOperationExecutors();

        if (recoveryPath.command === 'retry') {
            requireCapability(access, 'operation.apply');
            const retry = options.operationRetry || retryAdminOperation;
            const result = await retry(db, recoveryPath.code, actor, { executors });
            sendJson(res, result.ok ? 200 : 409, result);
            return true;
        }
        if (recoveryPath.command === 'compensate') {
            requireCapability(access, 'operation.undo');
            const compensate = options.operationCompensate || compensateAdminOperation;
            const result = await compensate(db, recoveryPath.code, actor, { executors });
            sendJson(res, result.ok ? 200 : 409, result);
            return true;
        }
        requireCapability(access, 'operation.apply');
        const acceptPartial = options.operationAcceptPartial || acceptPartialAdminOperation;
        sendJson(res, 200, await acceptPartial(db, recoveryPath.code, actor, body.justification));
        return true;
    } catch (error) {
        sendJson(res, Number(error?.status || 400), {
            ok: false,
            error: error?.code || 'admin_recovery_request_failed',
            message: error?.message || 'Não foi possível recuperar a operação administrativa.',
            details: error?.details || null,
        });
        return true;
    }
}

async function handlePolicyCatalog(req, res, options) {
    const method = String(req.method || 'GET').toUpperCase();
    setRecoveryCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }
    const context = await base.resolveAdminContext(req, res, options);
    if (!context) return true;
    try {
        if (method !== 'GET') throw methodNotAllowed();
        requireCapability(context.access, 'operation.view');
        sendJson(res, 200, {
            ok: true,
            defaultPolicy: 'per_target',
            policies: EXECUTION_POLICIES,
            atomicSafeActionTypes: [...ATOMIC_SAFE_ACTION_TYPES].sort(),
        });
        return true;
    } catch (error) {
        sendJson(res, Number(error?.status || 400), {
            ok: false,
            error: error?.code || 'admin_policy_request_failed',
            message: error?.message || 'Não foi possível consultar as políticas administrativas.',
            details: error?.details || null,
        });
        return true;
    }
}

async function handleAdminItemCatalog(req, res, options, itemPath) {
    const method = String(req.method || 'GET').toUpperCase();
    setRecoveryCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }
    const context = await base.resolveAdminContext(req, res, options);
    if (!context) return true;
    try {
        if (method !== 'GET') throw methodNotAllowed();
        requireCapability(context.access, 'catalog.view');
        await ensureInventoryV1(context.db);
        if (!itemPath.list) {
            const row = await context.db.get('SELECT * FROM clover_item_templates WHERE template_key = ? COLLATE NOCASE LIMIT 1', [String(itemPath.templateKey || '').trim()]);
            if (!row) {
                const error = new Error('Modelo de item não encontrado.');
                error.code = 'item_template_not_found';
                error.status = 404;
                throw error;
            }
            sendJson(res, 200, { ok: true, item: serializeTemplateRow(row) });
            return true;
        }

        const url = new URL(req.url || '/', 'http://localhost');
        const conditions = [];
        const params = [];
        const includeArchived = ['1', 'true', 'yes'].includes(String(url.searchParams.get('archived') || '').toLowerCase());
        const customOnly = ['1', 'true', 'yes'].includes(String(url.searchParams.get('custom') || '').toLowerCase());
        if (!includeArchived) {
            conditions.push('active = 1');
            conditions.push('archived_at IS NULL');
        }
        if (customOnly) conditions.push('is_custom = 1');
        const category = String(url.searchParams.get('category') || '').trim();
        if (category) {
            conditions.push('LOWER(category) = LOWER(?)');
            params.push(category);
        }
        const kind = String(url.searchParams.get('kind') || '').trim();
        if (kind) {
            conditions.push('LOWER(kind) = LOWER(?)');
            params.push(kind);
        }
        const query = String(url.searchParams.get('q') || '').trim();
        if (query) {
            const pattern = `%${query}%`;
            conditions.push(`(LOWER(template_key) LIKE LOWER(?) OR LOWER(item_name) LIKE LOWER(?) OR LOWER(COALESCE(description, '')) LIKE LOWER(?) OR LOWER(COALESCE(category, '')) LIKE LOWER(?) OR LOWER(COALESCE(kind, '')) LIKE LOWER(?))`);
            params.push(pattern, pattern, pattern, pattern, pattern);
        }
        const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 200));
        params.push(limit);
        const rows = await context.db.all(
            `SELECT * FROM clover_item_templates
             ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
             ORDER BY active DESC, category ASC, item_name COLLATE NOCASE ASC, template_key ASC
             LIMIT ?`,
            params
        );
        sendJson(res, 200, { ok: true, items: rows.map(serializeTemplateRow) });
        return true;
    } catch (error) {
        sendJson(res, Number(error?.status || 400), {
            ok: false,
            error: error?.code || 'admin_item_catalog_failed',
            message: error?.message || 'Não foi possível consultar o catálogo de itens.',
            details: error?.details || null,
        });
        return true;
    }
}

async function handleAdminApiSupport(req, res, options = {}) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (commandCenterPath(url.pathname)) {
        return handleAdminCommandCenterHttp(req, res, { ...options, resolveAdminContext: base.resolveAdminContext });
    }
    if (parseCanonicalAdminTeamPath(url.pathname)) {
        return handleCanonicalAdminTeamHttp(req, res, {
            ...options,
            resolveAdminContext: base.resolveAdminContext,
            readJsonBody: base.readJsonBody,
        });
    }
    if (url.pathname === '/admin/operation-policies') return handlePolicyCatalog(req, res, options);
    const itemPath = parseAdminItemPath(url.pathname);
    if (itemPath) return handleAdminItemCatalog(req, res, options, itemPath);
    const inventoryPath = parseAdminInventoryPath(url.pathname);
    if (inventoryPath) {
        return handleAdminInventoryInstanceHttp(req, res, {
            ...options,
            resolveAdminContext: base.resolveAdminContext,
        }, inventoryPath);
    }
    const recoveryPath = parseRecoveryOperationPath(url.pathname);
    if (recoveryPath) return handleRecoveryOperation(req, res, options, recoveryPath);
    return base.handleAdminApiSupport(req, res, options);
}

module.exports = {
    ...base,
    commandCenterPath,
    handleAdminApiSupport,
    handleAdminCommandCenterHttp,
    handleAdminInventoryInstanceHttp,
    handleAdminItemCatalog,
    handleCanonicalAdminTeamHttp,
    handlePolicyCatalog,
    isRecognizedAdminPath,
    parseAdminInventoryPath,
    parseAdminItemPath,
    parseCanonicalAdminTeamPath,
    parseOperationPath,
    parseRecoveryOperationPath,
};
