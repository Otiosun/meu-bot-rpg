'use strict';

const base = require('./adminApiSupportBase');
const { requiredCapabilitiesForActions } = require('./adminOperationContract');
const { EXECUTION_POLICIES } = require('./adminOperationPolicy');
const { getOperationByCode } = require('./adminOperationService');
const {
    ATOMIC_SAFE_ACTION_TYPES,
    getAdminOperationExecutors,
} = require('./adminOperationRegistry');
const {
    acceptPartialAdminOperation,
    compensateAdminOperation,
    retryAdminOperation,
} = require('./adminOperationRecoveryService');

function setRecoveryCors(req, res) {
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
    const match = String(pathname || '').match(
        /^\/admin\/operations\/(OP-[A-F0-9]{6})\/(retry|compensate|accept-partial)$/i
    );
    if (!match) return null;
    return { code: match[1].toUpperCase(), command: match[2].toLowerCase() };
}

function parseOperationPath(pathname) {
    return parseRecoveryOperationPath(pathname) || base.parseOperationPath(pathname);
}

function isRecognizedAdminPath(url) {
    return Boolean(parseRecoveryOperationPath(url?.pathname)) || base.isRecognizedAdminPath(url);
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
        const operation = await getOperation(db, recoveryPath.code, {
            includeEvents: true,
            includeUnits: true,
        });
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
        sendJson(res, 200, await acceptPartial(
            db,
            recoveryPath.code,
            actor,
            body.justification
        ));
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

async function handleAdminApiSupport(req, res, options = {}) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/admin/operation-policies') {
        return handlePolicyCatalog(req, res, options);
    }
    const recoveryPath = parseRecoveryOperationPath(url.pathname);
    if (recoveryPath) return handleRecoveryOperation(req, res, options, recoveryPath);
    return base.handleAdminApiSupport(req, res, options);
}

module.exports = {
    ...base,
    handleAdminApiSupport,
    handlePolicyCatalog,
    isRecognizedAdminPath,
    parseOperationPath,
    parseRecoveryOperationPath,
};
