'use strict';

const { getAdminActorAccess } = require('./adminAccessService');
const { runEconomyMutationExclusive } = require('./economyMutationQueue');
const { authenticateSiteSession } = require('./siteAuthService');
const { buyNode, getNodeDetails } = require('./skillTreeService');
const {
    SkillApprovalError,
    approveSkillApproval,
    listSkillApprovals,
    rejectSkillApproval,
    requestSkillApproval,
} = require('./skillApprovalService');

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function setCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Idempotency-Key, X-Request-Id, ngrok-skip-browser-warning'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
}

function bearerToken(req) {
    const match = String(req.headers?.authorization || '').trim().match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > maxBytes) {
            const error = new Error('Corpo da requisição grande demais.');
            error.status = 413;
            error.code = 'payload_too_large';
            throw error;
        }
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        const error = new Error('JSON inválido.');
        error.status = 400;
        error.code = 'invalid_json';
        throw error;
    }
}

async function requireSession(db, req, authenticate = authenticateSiteSession) {
    const auth = await authenticate(db, bearerToken(req));
    if (!auth?.ok || !auth.player?.id) {
        const error = new Error('Sessão inválida ou expirada.');
        error.status = 401;
        error.code = auth?.reason || 'invalid_session';
        throw error;
    }
    return auth;
}

function parseSkillApprovalRoute(pathname) {
    const path = String(pathname || '');
    const purchase = path.match(/^\/trees\/([^/]+)\/purchase$/);
    if (purchase) {
        return { kind: 'purchase', treeId: decodeURIComponent(purchase[1]) };
    }
    if (path === '/admin/skill-approvals') return { kind: 'admin-list' };
    const review = path.match(/^\/admin\/skill-approvals\/([^/]+)\/(approve|reject)$/);
    if (review) {
        return {
            kind: 'admin-review',
            requestRef: decodeURIComponent(review[1]),
            decision: review[2],
        };
    }
    return null;
}

async function requireSkillReviewer(db, actorId, options = {}) {
    const resolver = options.accessResolver || getAdminActorAccess;
    const access = await resolver(db, actorId, options.accessOptions || {});
    if (!access?.ok) {
        const error = new Error('Sua conta não possui acesso à Central ADM.');
        error.status = 403;
        error.code = access?.code || 'admin_access_denied';
        throw error;
    }
    if (!access.actor?.capabilities?.includes('player.manage')) {
        const error = new Error('Seu perfil não possui permissão para revisar melhorias.');
        error.status = 403;
        error.code = 'missing_capability';
        error.details = { capability: 'player.manage' };
        throw error;
    }
    return access;
}

function statusForError(error) {
    if (error instanceof SkillApprovalError) return Number(error.status || 400);
    return Number(error?.status || 500);
}

async function handlePlayerPurchase(req, res, route, context, options = {}) {
    if (context.method !== 'POST') {
        const error = new Error('Método não permitido.');
        error.status = 405;
        error.code = 'method_not_allowed';
        throw error;
    }
    const body = await readJsonBody(req);
    const nodeAlias = body.nodeId || body.node_id || body.nodeAlias || body.node_alias;
    if (!nodeAlias) {
        const error = new Error('Informe nodeId ou nodeAlias.');
        error.status = 400;
        error.code = 'missing_node';
        throw error;
    }

    const getDetails = options.getNodeDetails || getNodeDetails;
    const details = await getDetails(context.db, context.playerId, route.treeId, nodeAlias);
    if (details?.ok && details.nodeState?.status === 'approval') {
        const requestApproval = options.requestSkillApproval || requestSkillApproval;
        const runner = options.mutationRunner || runEconomyMutationExclusive;
        const result = await runner(
            () => requestApproval(
                context.db,
                context.playerId,
                route.treeId,
                nodeAlias,
                context.playerId
            ),
            { operation: `site:skill-approval-request:${route.treeId}` }
        );
        sendJson(res, 202, {
            ...result,
            requiresApproval: true,
            applied: false,
        });
        return true;
    }

    const purchase = options.buyNode || buyNode;
    const runner = options.mutationRunner || runEconomyMutationExclusive;
    const result = await runner(
        () => purchase(context.db, context.playerId, route.treeId, nodeAlias, context.playerId, {
            source: 'site_purchase',
            metadata: { via: 'lovable_site' },
        }),
        { operation: `site:skill-purchase:${route.treeId}` }
    );
    if (!result?.ok) {
        sendJson(res, 400, {
            ...result,
            ok: false,
            error: result?.reason || 'purchase_failed',
            message: 'Compra não aplicada.',
        });
        return true;
    }
    sendJson(res, 200, { ...result, applied: true, requiresApproval: false });
    return true;
}

async function handleAdmin(req, res, route, context, options = {}) {
    await requireSkillReviewer(context.db, context.playerId, options);
    if (route.kind === 'admin-list') {
        if (context.method !== 'GET') {
            const error = new Error('Método não permitido.');
            error.status = 405;
            error.code = 'method_not_allowed';
            throw error;
        }
        const list = options.listSkillApprovals || listSkillApprovals;
        const requests = await list(context.db, {
            status: context.url.searchParams.get('status') || 'pending',
            limit: context.url.searchParams.get('limit') || 100,
        });
        sendJson(res, 200, { ok: true, requests });
        return true;
    }

    if (context.method !== 'POST') {
        const error = new Error('Método não permitido.');
        error.status = 405;
        error.code = 'method_not_allowed';
        throw error;
    }
    const body = await readJsonBody(req);
    const runner = options.mutationRunner || runEconomyMutationExclusive;
    const review = route.decision === 'approve'
        ? (options.approveSkillApproval || approveSkillApproval)
        : (options.rejectSkillApproval || rejectSkillApproval);
    const result = await runner(
        () => review(
            context.db,
            route.requestRef,
            context.playerId,
            body.reason || null
        ),
        { operation: `admin:skill-approval:${route.decision}:${route.requestRef}` }
    );
    sendJson(res, 200, result);
    return true;
}

async function handleSkillApprovalHttp(req, res, options = {}) {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = parseSkillApprovalRoute(url.pathname);
    if (!route) return false;

    const method = String(req.method || 'GET').toUpperCase();
    setCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }

    const db = options.getDb?.();
    if (!db) {
        sendJson(res, 503, {
            ok: false,
            error: 'database_unavailable',
            message: 'Banco ainda não está pronto.',
        });
        return true;
    }

    try {
        const auth = await requireSession(
            db,
            req,
            options.authenticateSession || authenticateSiteSession
        );
        const context = {
            db,
            method,
            url,
            playerId: auth.player.id,
        };
        if (route.kind === 'purchase') {
            return handlePlayerPurchase(req, res, route, context, options);
        }
        return handleAdmin(req, res, route, context, options);
    } catch (error) {
        sendJson(res, statusForError(error), {
            ok: false,
            error: error?.code || 'skill_approval_request_failed',
            message: error?.message || 'Não foi possível processar a aprovação de melhoria.',
            details: error?.details || null,
        });
        return true;
    }
}

module.exports = {
    handleAdmin,
    handlePlayerPurchase,
    handleSkillApprovalHttp,
    parseSkillApprovalRoute,
    requireSkillReviewer,
    statusForError,
};
