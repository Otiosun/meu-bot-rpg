'use strict';

const {
    getAdminCommandCenter,
    getAdminUnifiedHistory,
} = require('./adminCommandCenterService');
const {
    getAdminSpellReviewInboxReadModel,
} = require('./adminSpellReviewInboxRead');
const { routeDescriptor } = require('./httpRouteDescriptor');

const PRIORITY_WEIGHT = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });

function setCors(req, res) {
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

const ADMIN_COMMAND_CENTER_ROUTE_DESCRIPTORS = Object.freeze([
    routeDescriptor({ id: 'admin.command-center.inbox', methods: ['GET'], template: '/admin/inbox', samplePath: '/admin/inbox', match: (p) => p === '/admin/inbox', handlerOwner: 'handleAdminCommandCenterHttp', sourceFile: 'helpers/clover/adminCommandCenterHttp.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-command-center-v1', contractShapeId: 'admin-command-center-inbox-shape-v1' }),
    routeDescriptor({ id: 'admin.command-center.history', methods: ['GET'], template: '/admin/history', samplePath: '/admin/history', match: (p) => p === '/admin/history', handlerOwner: 'handleAdminCommandCenterHttp', sourceFile: 'helpers/clover/adminCommandCenterHttp.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-command-center-v1', contractShapeId: 'admin-command-center-history-shape-v1' }),
]);

function commandCenterPath(pathname) {
    const route = ADMIN_COMMAND_CENTER_ROUTE_DESCRIPTORS.find((descriptor) => descriptor.match(pathname));
    return route?.id.endsWith('.inbox') ? 'inbox' : route?.id.endsWith('.history') ? 'history' : null;
}

function capabilitySet(access) {
    return new Set(access?.actor?.capabilities || []);
}

function timestampValue(value) {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : 0;
}

function compareInboxItems(left, right) {
    return (PRIORITY_WEIGHT[left.priority] ?? 9) - (PRIORITY_WEIGHT[right.priority] ?? 9)
        || timestampValue(right.updatedAt) - timestampValue(left.updatedAt)
        || String(left.id || '').localeCompare(String(right.id || ''));
}

function mergeSpellReviewInbox(payload, spellReview, limit) {
    const spellItems = spellReview?.items || [];
    const parsedLimit = Number(limit);
    const boundedLimit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(100, Math.trunc(parsedLimit)))
        : 20;
    return {
        ...payload,
        items: [...(payload.items || []), ...spellItems]
            .sort(compareInboxItems)
            .slice(0, boundedLimit),
        sections: {
            ...(payload.sections || {}),
            spellReviews: spellItems,
            spellReviewFlow: spellReview?.flow || null,
        },
    };
}

function visibleInbox(payload, access) {
    const capabilities = capabilitySet(access);
    const owner = access?.actor?.role === 'owner';
    const canViewSpellReviews = owner || capabilities.has('player.view') || capabilities.has('player.manage');
    const canManageSpellReviews = owner || capabilities.has('player.manage');
    const allowedCategories = new Set();
    if (capabilities.has('operation.view')) allowedCategories.add('operation');
    if (capabilities.has('raid.reward.review') || capabilities.has('raid.view')) {
        allowedCategories.add('raid_reward_proposal');
    }
    if (owner) allowedCategories.add('admin_role_change');
    if (capabilities.has('integrity.view')) {
        allowedCategories.add('integrity');
        allowedCategories.add('stars_integrity');
    }
    if (canViewSpellReviews) allowedCategories.add('spell_review');

    const items = (payload.items || []).filter((item) => allowedCategories.has(item.category));
    const priorities = { critical: 0, high: 0, medium: 0, low: 0 };
    const categories = {};
    for (const item of items) {
        priorities[item.priority] = Number(priorities[item.priority] || 0) + 1;
        categories[item.category] = Number(categories[item.category] || 0) + 1;
    }

    return {
        ...payload,
        permissions: {
            ...(payload.permissions || {}),
            canManageSpellReviews,
        },
        summary: {
            total: items.length,
            priorities,
            categories,
            recoverableOperations: categories.operation || 0,
            raidRewardProposals: categories.raid_reward_proposal || 0,
            adminRoleChanges: categories.admin_role_change || 0,
            starAnomalies: categories.stars_integrity || 0,
            spellReviews: categories.spell_review || 0,
            integrityIssues: capabilities.has('integrity.view')
                ? Number(payload.sections?.integrity?.summary?.total
                    || payload.sections?.integrity?.issues?.length
                    || 0)
                : 0,
        },
        items,
        sections: {
            operations: capabilities.has('operation.view')
                ? payload.sections.operations
                : [],
            raidRewardProposals: (
                capabilities.has('raid.reward.review') || capabilities.has('raid.view')
            ) ? payload.sections.raidRewardProposals : [],
            adminRoleChanges: owner ? payload.sections.adminRoleChanges : [],
            starAnomalies: capabilities.has('integrity.view')
                ? payload.sections.starAnomalies
                : [],
            spellReviews: canViewSpellReviews
                ? (payload.sections.spellReviews || [])
                : [],
            spellReviewFlow: canViewSpellReviews
                ? (payload.sections.spellReviewFlow || null)
                : null,
            integrity: capabilities.has('integrity.view')
                ? payload.sections.integrity
                : null,
        },
    };
}

function visibleHistory(payload, access) {
    const capabilities = capabilitySet(access);
    const owner = access?.actor?.role === 'owner';
    const events = (payload.events || []).filter((event) => {
        if (event.type === 'operation') return capabilities.has('operation.view');
        if (event.type === 'admin_role') return owner;
        if (event.type === 'raid_reward_proposal') {
            return capabilities.has('raid.reward.review') || capabilities.has('raid.view');
        }
        return false;
    });
    return {
        ...payload,
        events,
        sources: {
            operations: events.filter((event) => event.type === 'operation').length,
            adminRoles: events.filter((event) => event.type === 'admin_role').length,
            raidRewardProposals: events.filter((event) => event.type === 'raid_reward_proposal').length,
        },
    };
}

async function handleAdminCommandCenterHttp(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const route = commandCenterPath(url.pathname);
    if (!route) return false;

    setCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }

    const resolveContext = options.resolveAdminContext;
    if (typeof resolveContext !== 'function') {
        sendJson(res, 500, {
            ok: false,
            error: 'admin_context_resolver_missing',
            message: 'Contexto administrativo indisponível.',
        });
        return true;
    }
    const context = await resolveContext(req, res, options);
    if (!context) return true;

    try {
        if (method !== 'GET') {
            const error = new Error('Método não permitido.');
            error.code = 'method_not_allowed';
            error.status = 405;
            throw error;
        }

        const capabilities = capabilitySet(context.access);
        const owner = context.access?.actor?.role === 'owner';
        const canReadAny = owner
            || capabilities.has('operation.view')
            || capabilities.has('raid.view')
            || capabilities.has('raid.reward.review')
            || capabilities.has('integrity.view')
            || capabilities.has('player.manage');
        if (!canReadAny) {
            const error = new Error('Seu perfil não possui acesso à fila operacional.');
            error.code = 'missing_capability';
            error.status = 403;
            throw error;
        }

        if (route === 'inbox') {
            const resolver = options.commandCenterResolver || getAdminCommandCenter;
            const spellReviewResolver = options.spellReviewInboxResolver
                || getAdminSpellReviewInboxReadModel;
            const limit = url.searchParams.get('limit') || undefined;
            const [payload, spellReview] = await Promise.all([
                resolver(context.db, {
                    limit,
                    sampleLimit: url.searchParams.get('sampleLimit') || undefined,
                }),
                spellReviewResolver(context.db, { limit }),
            ]);
            const merged = mergeSpellReviewInbox(payload, spellReview, limit);
            sendJson(res, 200, visibleInbox(merged, context.access));
            return true;
        }

        const resolver = options.commandHistoryResolver || getAdminUnifiedHistory;
        const payload = await resolver(context.db, {
            limit: url.searchParams.get('limit') || undefined,
            type: url.searchParams.get('type') || undefined,
            query: url.searchParams.get('q') || undefined,
        });
        sendJson(res, 200, visibleHistory(payload, context.access));
        return true;
    } catch (error) {
        sendJson(res, Number(error?.status || 400), {
            ok: false,
            error: error?.code || 'admin_command_center_failed',
            message: error?.message || 'Não foi possível abrir a fila administrativa.',
            details: error?.details || null,
        });
        return true;
    }
}

module.exports = {
    ADMIN_COMMAND_CENTER_ROUTE_DESCRIPTORS,
    commandCenterPath,
    handleAdminCommandCenterHttp,
    mergeSpellReviewInbox,
    visibleHistory,
    visibleInbox,
};
