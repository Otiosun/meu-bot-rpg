'use strict';

const {
    ADMIN_MISSION_TYPES,
    MISSION_RANK_GUIDE,
    MISSION_STATUSES,
    getMission,
    listMissions,
} = require('./adminMissionService');

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

function requireCapability(access, capability) {
    if (access?.actor?.capabilities?.includes(capability)) return;
    const error = new Error('Seu perfil não possui a permissão necessária.');
    error.code = 'missing_capability';
    error.status = 403;
    error.details = { capability };
    throw error;
}

function parseAdminMissionPath(pathname) {
    const path = String(pathname || '');
    if (path === '/admin/missions') return { kind: 'list' };
    const match = path.match(/^\/admin\/missions\/([^/]+)$/);
    if (!match) return null;
    let missionKey = match[1];
    try { missionKey = decodeURIComponent(missionKey); } catch {}
    return { kind: 'detail', missionKey };
}

async function handleAdminMissionHttp(req, res, options = {}, parsedPath = null) {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = parsedPath || parseAdminMissionPath(url.pathname);
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
        requireCapability(context.access, 'catalog.view');

        if (route.kind === 'list') {
            const missions = await listMissions(context.db, {
                status: url.searchParams.get('status') || undefined,
                rank: url.searchParams.get('rank') || undefined,
            });
            sendJson(res, 200, {
                ok: true,
                missions,
                rankGuide: MISSION_RANK_GUIDE,
                missionTypes: ADMIN_MISSION_TYPES,
                statuses: MISSION_STATUSES,
                rules: {
                    autoNarratedDefaultWeeklyLimitPerPlayer: 2,
                    exceptionalYullsThreshold: 7000,
                },
            });
            return true;
        }

        const mission = await getMission(context.db, route.missionKey);
        if (!mission) {
            sendJson(res, 404, {
                ok: false,
                error: 'mission_not_found',
                message: 'Missão não encontrada.',
            });
            return true;
        }
        sendJson(res, 200, { ok: true, mission });
    } catch (error) {
        sendJson(res, Number(error?.status || 400), {
            ok: false,
            error: error?.code || 'admin_mission_request_failed',
            message: error?.message || 'Não foi possível consultar Missões.',
            details: error?.details || null,
        });
    }
    return true;
}

module.exports = {
    handleAdminMissionHttp,
    parseAdminMissionPath,
};
