'use strict';

const {
    getAdminBoxDashboard,
    getAdminPlayerBoxState,
} = require('./adminBoxService');

function setCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, X-Request-Id, ngrok-skip-browser-warning');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function parseAdminBoxPath(pathname) {
    const path = String(pathname || '');
    if (path === '/admin/boxes') return { kind: 'dashboard' };
    const player = path.match(/^\/admin\/boxes\/player\/([^/]+)$/);
    if (!player) return null;
    let playerId = player[1];
    try { playerId = decodeURIComponent(playerId); } catch { /* falha fechada no serviço */ }
    return { kind: 'player', playerId };
}

function requireCapability(access, capability) {
    if (access?.actor?.capabilities?.includes(capability)) return;
    const error = new Error('Seu perfil não possui a permissão necessária.');
    error.code = 'missing_capability';
    error.status = 403;
    error.details = { capability };
    throw error;
}

async function handleAdminBoxHttp(req, res, options = {}, parsedPath = null) {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = parsedPath || parseAdminBoxPath(url.pathname);
    if (!route) return false;

    setCors(req, res);
    const method = String(req.method || 'GET').toUpperCase();
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

        if (route.kind === 'dashboard') {
            requireCapability(context.access, 'catalog.view');
            const resolver = options.adminBoxDashboard || getAdminBoxDashboard;
            sendJson(res, 200, await resolver(context.db, {
                limit: url.searchParams.get('limit') || undefined,
                status: url.searchParams.get('status') || undefined,
                boxKey: url.searchParams.get('box') || undefined,
                query: url.searchParams.get('q') || undefined,
            }));
            return true;
        }

        requireCapability(context.access, 'player.view');
        const resolver = options.adminPlayerBoxState || getAdminPlayerBoxState;
        sendJson(res, 200, await resolver(context.db, route.playerId, {
            limit: url.searchParams.get('limit') || undefined,
        }));
        return true;
    } catch (error) {
        sendJson(res, Number(error?.status || 400), {
            ok: false,
            error: error?.code || 'admin_box_request_failed',
            message: error?.message || 'Não foi possível consultar o domínio de Caixas.',
            details: error?.details || null,
        });
        return true;
    }
}

module.exports = {
    handleAdminBoxHttp,
    parseAdminBoxPath,
};