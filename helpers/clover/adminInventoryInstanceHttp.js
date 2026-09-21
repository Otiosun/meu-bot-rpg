'use strict';

const {
    getAdminInventoryInstance,
    listAdminPlayerInventory,
} = require('./adminInventoryInstanceService');

function parseAdminInventoryPath(pathname) {
    const match = String(pathname || '').match(/^\/admin\/players\/([^/]+)\/inventory(?:\/(\d+))?$/i);
    if (!match) return null;
    let playerId = match[1];
    try { playerId = decodeURIComponent(playerId); } catch { /* fail closed downstream */ }
    return {
        playerId: String(playerId || '').trim(),
        itemId: match[2] ? Number(match[2]) : null,
        list: !match[2],
    };
}

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function setCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, X-Request-Id, ngrok-skip-browser-warning');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function requirePlayerView(access) {
    if (access?.actor?.capabilities?.includes('player.view')) return;
    const error = new Error('Seu perfil não possui permissão para consultar inventário de jogadores.');
    error.code = 'missing_capability';
    error.status = 403;
    error.details = { capability: 'player.view' };
    throw error;
}

async function handleAdminInventoryInstanceHttp(req, res, options, parsed) {
    const method = String(req.method || 'GET').toUpperCase();
    setCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }

    const context = await options.resolveAdminContext(req, res, options);
    if (!context) return true;
    try {
        if (method !== 'GET') {
            const error = new Error('Método não permitido para esta rota administrativa.');
            error.code = 'method_not_allowed';
            error.status = 405;
            throw error;
        }
        requirePlayerView(context.access);
        const url = new URL(req.url || '/', 'http://localhost');
        if (parsed.list) {
            const result = await listAdminPlayerInventory(context.db, parsed.playerId, {
                limit: url.searchParams.get('limit'),
            });
            sendJson(res, 200, result);
            return true;
        }
        const result = await getAdminInventoryInstance(context.db, parsed.playerId, parsed.itemId, {
            historyLimit: url.searchParams.get('historyLimit'),
        });
        sendJson(res, 200, result);
        return true;
    } catch (error) {
        sendJson(res, Number(error?.status || 400), {
            ok: false,
            error: error?.code || 'admin_inventory_instance_failed',
            message: error?.message || 'Não foi possível consultar o exemplar de inventário.',
            details: error?.details || null,
        });
        return true;
    }
}

module.exports = {
    handleAdminInventoryInstanceHttp,
    parseAdminInventoryPath,
};
