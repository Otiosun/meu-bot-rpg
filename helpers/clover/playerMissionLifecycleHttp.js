'use strict';

// Shared API for site and WhatsApp lifecycle. All player identity comes from
// the authenticated session, never from client-supplied playerId.
const { authenticateSiteSession } = require('./siteAuthService');
const { getPlayerPhase } = require('./playerPhase');
const { resolveAdminContext } = require('./adminApiSupportBase');
const { listPublicMissions, getPublicMission } = require('./playerMissionBoardService');
const {
    getMyMission, listMyMissions, getMissionReviewDossier, joinMission, startMission, submitMission,
    listPendingReviews, reviewMission,
} = require('./playerMissionLifecycleService');

function routeFor(pathname) {
    if (pathname === '/missions') return { kind: 'list' };
    if (pathname === '/missions/me/history') return { kind: 'history' };
    if (pathname === '/admin/mission-submissions') return { kind: 'queue' };
    const review = pathname.match(/^\/admin\/mission-submissions\/([^/]+)\/([^/]+)\/review$/);
    if (review) return { kind: 'review', key: review[1], playerId: review[2] };
    const dossier = pathname.match(/^\/admin\/mission-submissions\/([^/]+)\/([^/]+)$/);
    if (dossier) return { kind: 'dossier', key: dossier[1], playerId: dossier[2] };
    const match = pathname.match(/^\/missions\/([^/]+)(?:\/(join|start|submit|me|record))?$/);
    if (match) return { kind: match[2] || 'detail', key: match[1] };
    return null;
}
function send(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(payload));
}
async function bodyJson(req) {
    const parts = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > 32768) {
            const error = new Error('Entrega muito grande.');
            error.status = 413;
            error.code = 'payload_too_large';
            throw error;
        }
        parts.push(chunk);
    }
    try { return parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}; }
    catch {
        const error = new Error('JSON inválido.');
        error.status = 400;
        error.code = 'invalid_json';
        throw error;
    }
}
function keyFromPath(raw) {
    try { return decodeURIComponent(raw); }
    catch {
        const error = new Error('Código inválido.');
        error.status = 400;
        error.code = 'invalid_path';
        throw error;
    }
}
async function handleMissionLifecycleHttp(req, res, options = {}) {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = routeFor(url.pathname);
    if (!route) return false;

    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true; }

    try {
        const method = String(req.method || 'GET').toUpperCase();
        const expected = ['join', 'start', 'submit', 'review'].includes(route.kind) ? 'POST' : 'GET';
        if (method !== expected) {
            const error = new Error('Método não permitido.');
            error.status = 405;
            error.code = 'method_not_allowed';
            throw error;
        }
        const db = options.getDb?.();
        if (!db) {
            send(res, 503, { ok: false, error: 'database_unavailable' });
            return true;
        }
        if (['queue', 'review', 'dossier'].includes(route.kind)) {
            const context = await resolveAdminContext(req, res, options);
            if (!context) return true;
            const access = context.access;
            if (!access?.actor?.capabilities?.includes('mission.manage')) {
                send(res, 403, { ok: false, error: 'missing_capability' });
                return true;
            }
            if (route.kind === 'queue') {
                send(res, 200, { ok: true, submissions: await listPendingReviews(db) });
                return true;
            }
            if (route.kind === 'dossier') {
                const dossier = await getMissionReviewDossier(db, keyFromPath(route.key), keyFromPath(route.playerId), { staff: true });
                send(res, dossier ? 200 : 404, dossier ? { ok: true, dossier } : { ok: false, error: 'mission_not_joined' });
                return true;
            }
            const body = await bodyJson(req);
            if (!Number.isSafeInteger(body?.expectedSubmissionRevision) || body.expectedSubmissionRevision < 1) {
                send(res, 400, { ok: false, error: 'mission_review_revision_required', message: 'Abra a entrega atual antes de confirmar a avaliação.' });
                return true;
            }
            const result = await reviewMission(db, {
                missionKey: keyFromPath(route.key),
                playerId: keyFromPath(route.playerId),
                actorId: access.actor.id,
                decision: body.decision,
                reason: body.reason,
                expectedSubmissionRevision: body.expectedSubmissionRevision,
            });
            send(res, 200, { ok: true, ...result });
            return true;
        }
        const token = String(req.headers?.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
        const auth = await (options.authenticateSession ? options.authenticateSession(db, req) : authenticateSiteSession(db, token));
        if (!auth.ok) {
            send(res, 401, { ok: false, error: 'invalid_session' });
            return true;
        }
        const playerId = auth.player.id;
        if (route.kind === 'list') {
            send(res, 200, { ok: true, ...(await listPublicMissions(db, {
                rank: url.searchParams.get('rank'), page: url.searchParams.get('page'), limit: 6,
            })) });
            return true;
        }
        if (route.kind === 'history') {
            send(res, 200, { ok: true, ...await listMyMissions(db, playerId, { page: Number(url.searchParams.get('page') || 1) }) });
            return true;
        }
        const missionKey = keyFromPath(route.key);
        if (route.kind === 'record') {
            const dossier = await getMissionReviewDossier(db, missionKey, playerId);
            send(res, dossier ? 200 : 404, dossier ? { ok: true, dossier } : { ok: false, error: 'mission_not_joined' });
            return true;
        }
        if (route.kind === 'detail') {
            const mission = await getPublicMission(db, missionKey);
            if (!mission) { send(res, 404, { ok: false, error: 'mission_not_found' }); return true; }
            send(res, 200, { ok: true, mission });
            return true;
        }
        if (route.kind === 'me') {
            send(res, 200, { ok: true, participation: await getMyMission(db, missionKey, playerId) });
            return true;
        }
        const phase = await getPlayerPhase(db, playerId);
        if (!phase.canPlay) {
            send(res, 403, { ok: false, error: 'game_not_released' });
            return true;
        }
        const result = route.kind === 'join'
            ? await joinMission(db, { missionKey, playerId })
            : route.kind === 'start'
                ? await startMission(db, { missionKey, playerId })
                : await submitMission(db, { missionKey, playerId, text: (await bodyJson(req)).text });
        send(res, result.duplicate ? 200 : 201, { ok: true, ...result });
    } catch (error) {
        const status = Number(error?.status || 500);
        const clientError = status >= 400 && status < 500;
        send(res, clientError ? status : 500, {
            ok: false,
            error: clientError ? (error?.code || 'mission_request_failed') : 'mission_internal_error',
            message: clientError ? error.message : 'Não foi possível realizar a operação.',
        });
    }
    return true;
}
module.exports = { handleMissionLifecycleHttp, routeFor };
