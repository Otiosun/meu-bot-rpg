'use strict';

const { getAdminActorAccess } = require('./adminAccessService');
const {
    getHookTemplate,
    listHookTemplates,
    listPlayerHookAssignments,
} = require('./adminHookService');
const {
    assignmentStage,
    effectPlanForStage,
    getHookV2Schema,
    readHookV2Spec,
} = require('./adminHookV2Service');
const { authenticateSiteSession } = require('./siteAuthService');
const { routeDescriptor } = require('./httpRouteDescriptor');

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

function parseHookDetailPath(pathname) {
    const match = String(pathname || '').match(/^\/admin\/hooks\/([^/]+)$/);
    if (!match || ['assignments', 'schema'].includes(match[1])) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
}

const ADMIN_HOOKS_ROUTE_DESCRIPTORS = Object.freeze([
    routeDescriptor({ id: 'admin.hooks.list', methods: ['GET'], template: '/admin/hooks', samplePath: '/admin/hooks', match: (p) => p === '/admin/hooks', handlerOwner: 'handleAdminHooksReadApi', sourceFile: 'helpers/clover/adminHooksReadApi.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-hooks-v2', contractShapeId: 'admin-hooks-list-shape-v2' }),
    routeDescriptor({ id: 'admin.hooks.schema', methods: ['GET'], template: '/admin/hooks/schema', samplePath: '/admin/hooks/schema', match: (p) => p === '/admin/hooks/schema', handlerOwner: 'handleAdminHooksReadApi', sourceFile: 'helpers/clover/adminHooksReadApi.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-hooks-v2', contractShapeId: 'admin-hooks-schema-shape-v2' }),
    routeDescriptor({ id: 'admin.hooks.assignments', methods: ['GET'], template: '/admin/hooks/assignments', samplePath: '/admin/hooks/assignments', match: (p) => p === '/admin/hooks/assignments', handlerOwner: 'handleAdminHooksReadApi', sourceFile: 'helpers/clover/adminHooksReadApi.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-hooks-v2', contractShapeId: 'admin-hook-assignments-list-shape-v2' }),
    routeDescriptor({ id: 'admin.hooks.detail', methods: ['GET'], template: '/admin/hooks/:hookId', samplePath: '/admin/hooks/example-hook', match: (p) => Boolean(parseHookDetailPath(p)), handlerOwner: 'handleAdminHooksReadApi', sourceFile: 'helpers/clover/adminHooksReadApi.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-hooks-v2', contractShapeId: 'admin-hook-detail-shape-v2' }),
]);

function isAdminHooksPath(pathname) {
    return ADMIN_HOOKS_ROUTE_DESCRIPTORS.some((route) => route.match(pathname));
}

function enabled(value) {
    return TRUE_VALUES.has(String(value || '').trim().toLowerCase());
}

function enrichHookV2(hook) {
    if (!hook) return hook;
    const spec = readHookV2Spec(hook);
    return { ...hook, v2: spec };
}

function enrichAssignmentV2(assignment) {
    if (!assignment) return assignment;
    const spec = assignment.metadata?.hookV2SpecSnapshot || readHookV2Spec(assignment.template || {});
    const stage = assignmentStage(assignment);
    return {
        ...assignment,
        template: enrichHookV2(assignment.template),
        v2: {
            spec,
            stage,
            effectPlan: effectPlanForStage(spec, stage),
            pendingEffects: assignment.metadata?.hookV2PendingEffects || [],
        },
    };
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

async function handleAdminHooksReadApi(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    if (!isAdminHooksPath(url.pathname)) return false;

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

        if (url.pathname === '/admin/hooks/schema') {
            sendJson(res, 200, getHookV2Schema());
            return true;
        }

        if (url.pathname === '/admin/hooks/assignments') {
            const listAssignments = options.listAssignments || listPlayerHookAssignments;
            const result = await listAssignments(context.db, {
                playerId: url.searchParams.get('playerId') || undefined,
                status: url.searchParams.get('status') || undefined,
                includeRemoved: enabled(url.searchParams.get('removed')),
                query: url.searchParams.get('q') || '',
                limit: url.searchParams.get('limit') || undefined,
            });
            sendJson(res, 200, {
                ...result,
                assignments: (result.assignments || []).map(enrichAssignmentV2),
                hookV2Version: 2,
            });
            return true;
        }

        const hookId = parseHookDetailPath(url.pathname);
        if (hookId) {
            const getHook = options.getHook || getHookTemplate;
            const hook = await getHook(context.db, hookId, { nullIfMissing: true });
            if (!hook) {
                const error = new Error('Gancho não encontrado.');
                error.code = 'hook_not_found';
                error.status = 404;
                throw error;
            }
            sendJson(res, 200, { ok: true, hook: enrichHookV2(hook), hookV2Version: 2 });
            return true;
        }

        const listHooks = options.listHooks || listHookTemplates;
        const result = await listHooks(context.db, {
            includeArchived: enabled(url.searchParams.get('archived')),
            query: url.searchParams.get('q') || '',
            limit: url.searchParams.get('limit') || undefined,
        });
        sendJson(res, 200, {
            ...result,
            hooks: (result.hooks || []).map(enrichHookV2),
            hookV2Version: 2,
        });
        return true;
    } catch (error) {
        sendJson(res, Number(error?.status || 400), {
            ok: false,
            error: error?.code || 'admin_hooks_request_failed',
            message: error?.message || 'Não foi possível consultar os ganchos.',
            details: error?.details || null,
        });
        return true;
    }
}

module.exports = {
    ADMIN_HOOKS_ROUTE_DESCRIPTORS,
    enrichAssignmentV2,
    enrichHookV2,
    handleAdminHooksReadApi,
    isAdminHooksPath,
    parseHookDetailPath,
};
