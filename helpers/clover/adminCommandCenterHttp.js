'use strict';

const {
    getAdminCommandCenter,
    getAdminUnifiedHistory,
} = require('./adminCommandCenterServiceV2');

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

function commandCenterPath(pathname) {
    if (pathname === '/admin/inbox') return 'inbox';
    if (pathname === '/admin/history') return 'history';
    return null;
}

function capabilitySet(access) {
    return new Set(access?.actor?.capabilities || []);
}

function visibleInbox(payload, access) {
    const capabilities = capabilitySet(access);
    const owner = access?.actor?.role === 'owner';
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
    if (capabilities.has('player.view')) allowedCategories.add('spell_review');

    const items = (payload.items || []).filter((item) => allowedCategories.has(item.category));
    const priorities = { critical: 0, high: 0, medium: 0, low: 0 };
    const categories = {};
    for (const item of items) {
        priorities[item.priority] = Number(priorities[item.priority] || 0) + 1;
        categories[item.category] = Number(categories[item.category] || 0) + 1;
    }

    return {
        ...payload,
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
            spellReviews: capabilities.has('player.view')
                ? payload.sections.spellReviews || []
                : [],
            spellReviewFlow: capabilities.has('player.view')
                ? payload.sections.spellReviewFlow || null
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
            || capabilities.has('player.view');
        if (!canReadAny) {
            const error = new Error('Seu perfil não possui acesso à fila operacional.');
            error.code = 'missing_capability';
            error.status = 403;
            throw error;
        }

        if (route === 'inbox') {
            const resolver = options.commandCenterResolver || getAdminCommandCenter;
            const payload = await resolver(context.db, {
                limit: url.searchParams.get('limit') || undefined,
                sampleLimit: url.searchParams.get('sampleLimit') || undefined,
            });
            sendJson(res, 200, visibleInbox(payload, context.access));
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
    commandCenterPath,
    handleAdminCommandCenterHttp,
    visibleHistory,
    visibleInbox,
};