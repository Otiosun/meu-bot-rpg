'use strict';

const base = require('./adminApiSupportBase');
const {
    ADMIN_HOOKS_ROUTE_DESCRIPTORS,
    handleAdminHooksReadApi,
    isAdminHooksPath,
} = require('./adminHooksReadApi');
const {
    ADMIN_COMMAND_CENTER_ROUTE_DESCRIPTORS,
    commandCenterPath,
    handleAdminCommandCenterHttp,
} = require('./adminCommandCenterHttp');
const {
    CANONICAL_ADMIN_TEAM_ROUTE_DESCRIPTORS,
    handleCanonicalAdminTeamHttp,
    parseCanonicalAdminTeamPath,
} = require('./canonicalAdminTeamHttp');
const { requiredCapabilitiesForActions } = require('./adminOperationContract');
const { EXECUTION_POLICIES } = require('./adminOperationPolicy');
const {
    buildAdminActionCoverage,
    unavailableAdminActionTypes,
} = require('./adminActionCoverage');
const { routeDescriptor } = require('./httpRouteDescriptor');
const { handleAdminSpellHttp, parseAdminSpellPath } = require('./adminSpellHttp');
const { handleAdminInventoryInstanceHttp, parseAdminInventoryPath } = require('./adminInventoryInstanceHttp');
const { handleAdminBoxHttp, parseAdminBoxPath } = require('./adminBoxHttp');
const {
    ADMIN_REWARDS_ROUTE_DESCRIPTORS,
    handleAdminRewardsReadApi,
    isAdminRewardsPath,
} = require('./adminRewardsReadApi');
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

const ADMIN_DELEGATED_ROUTE_DESCRIPTORS = Object.freeze([
    ...ADMIN_REWARDS_ROUTE_DESCRIPTORS,
    routeDescriptor({ id: 'admin.boxes.read', methods: ['GET'], template: '/admin/boxes', samplePath: '/admin/boxes', match: (path) => Boolean(parseAdminBoxPath(path)), handlerOwner: 'handleAdminBoxHttp', sourceFile: 'helpers/clover/adminBoxHttp.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-boxes-v1' }),
    routeDescriptor({ id: 'admin.player-inventory.read', methods: ['GET'], template: '/admin/players/:playerId/inventory', samplePath: '/admin/players/PL-TEST/inventory', match: (path) => Boolean(parseAdminInventoryPath(path)), handlerOwner: 'handleAdminInventoryInstanceHttp', sourceFile: 'helpers/clover/adminInventoryInstanceHttp.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-player-inventory-v1' }),
    routeDescriptor({ id: 'admin.player-spells.read', methods: ['GET'], template: '/admin/players/:playerId/spells', samplePath: '/admin/players/PL-TEST/spells', match: (path) => Boolean(parseAdminSpellPath(path)), handlerOwner: 'handleAdminSpellHttp', sourceFile: 'helpers/clover/adminSpellHttp.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-player-spells-v1' }),
    routeDescriptor({ id: 'admin.operation-policies.read', methods: ['GET'], template: '/admin/operation-policies', samplePath: '/admin/operation-policies', match: (path) => path === '/admin/operation-policies', handlerOwner: 'handlePolicyCatalog', sourceFile: 'helpers/clover/adminApiSupport.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-operation-policies-v1' }),
    routeDescriptor({ id: 'admin.operation.recovery', methods: ['POST'], template: '/admin/operations/:operationId/:recoveryCommand', samplePath: '/admin/operations/OP-A1B2C3/retry', match: (path) => Boolean(parseRecoveryOperationPath(path)), handlerOwner: 'handleRecoveryOperation', sourceFile: 'helpers/clover/adminApiSupport.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-operation-recovery-v1', contractShapeId: 'admin-operation-recovery-retry-shape-v1' }),
]);

function isRecognizedAdminPath(url) {
    const allDescriptors = [
        ...ADMIN_HOOKS_ROUTE_DESCRIPTORS,
        ...ADMIN_COMMAND_CENTER_ROUTE_DESCRIPTORS,
        ...CANONICAL_ADMIN_TEAM_ROUTE_DESCRIPTORS,
        ...ADMIN_DELEGATED_ROUTE_DESCRIPTORS,
    ];
    return allDescriptors.some((route) => route.match(url?.pathname)) || base.isRecognizedAdminPath(url);
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
            actions: buildAdminActionCoverage(),
            unavailableActionTypes: unavailableAdminActionTypes(),
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
    if (isAdminRewardsPath(url.pathname)) {
        return handleAdminRewardsReadApi(req, res, options);
    }
    const boxPath = parseAdminBoxPath(url.pathname);
    if (boxPath) {
        return handleAdminBoxHttp(req, res, {
            ...options,
            resolveAdminContext: base.resolveAdminContext,
        }, boxPath);
    }
    const inventoryPath = parseAdminInventoryPath(url.pathname);
    if (inventoryPath) {
        return handleAdminInventoryInstanceHttp(req, res, {
            ...options,
            resolveAdminContext: base.resolveAdminContext,
        }, inventoryPath);
    }
    const spellPath = parseAdminSpellPath(url.pathname);
    if (spellPath) {
        return handleAdminSpellHttp(req, res, {
            ...options,
            resolveAdminContext: base.resolveAdminContext,
        }, spellPath);
    }
    if (isAdminHooksPath(url.pathname)) {
        return handleAdminHooksReadApi(req, res, options);
    }
    if (commandCenterPath(url.pathname)) {
        return handleAdminCommandCenterHttp(req, res, {
            ...options,
            resolveAdminContext: base.resolveAdminContext,
        });
    }
    if (parseCanonicalAdminTeamPath(url.pathname)) {
        return handleCanonicalAdminTeamHttp(req, res, {
            ...options,
            resolveAdminContext: base.resolveAdminContext,
            readJsonBody: base.readJsonBody,
        });
    }
    if (ADMIN_DELEGATED_ROUTE_DESCRIPTORS.find((route) => route.id === 'admin.operation-policies.read').match(url.pathname)) {
        return handlePolicyCatalog(req, res, options);
    }
    const recoveryPath = ADMIN_DELEGATED_ROUTE_DESCRIPTORS.find((route) => route.id === 'admin.operation.recovery').match(url.pathname)
        ? parseRecoveryOperationPath(url.pathname)
        : null;
    if (recoveryPath) return handleRecoveryOperation(req, res, options, recoveryPath);
    return base.handleAdminApiSupport(req, res, options);
}

module.exports = {
    ...base,
    ADMIN_COMMAND_CENTER_ROUTE_DESCRIPTORS,
    ADMIN_DELEGATED_ROUTE_DESCRIPTORS,
    ADMIN_HOOKS_ROUTE_DESCRIPTORS,
    CANONICAL_ADMIN_TEAM_ROUTE_DESCRIPTORS,
    commandCenterPath,
    handleAdminApiSupport,
    handleAdminCommandCenterHttp,
    handleCanonicalAdminTeamHttp,
    handlePolicyCatalog,
    isRecognizedAdminPath,
    parseCanonicalAdminTeamPath,
    parseOperationPath,
    parseRecoveryOperationPath,
};
