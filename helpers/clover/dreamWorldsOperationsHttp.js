'use strict';

const { authenticateSiteSession } = require('./siteAuthService');
const { getAdminActorAccess } = require('./adminAccessService');
const { DreamWorldsServiceError } = require('./dreamWorldsService');
const {
    createResonanceFragment,
    getDreamRun,
    getPlayerDreamDashboardDetailed,
    getPlayerDreamRun,
    getPublicFragmentBySlug,
    grantResonanceFragment,
    listAdminDreamRuns,
    listAdminFragments,
    listPublicFragments,
    removeDreamSlot,
    respondDreamInvite,
    transitionDreamRun,
    updateResonanceFragment,
} = require('./dreamWorldsOperationsService');
const {
    assignDreamSlotWithPolicy,
    replaceDreamSlotWithPolicy,
} = require('./dreamWorldsSlotPolicyService');
const { matchDescriptor, routeDescriptor } = require('./httpRouteDescriptor');

function setCors(req, res) {
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

function bearerToken(req) {
    const value = String(req.headers?.authorization || '').trim();
    const match = value.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

async function readJsonBody(req, maxBytes = 128 * 1024) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > maxBytes) {
            const error = new Error('Corpo da requisição grande demais.');
            error.code = 'payload_too_large';
            error.status = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        const error = new Error('JSON inválido.');
        error.code = 'invalid_json';
        error.status = 400;
        throw error;
    }
}

function decode(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function parsePlayerPath(pathname) {
    if (pathname === '/dream-worlds/me') return { kind: 'dashboard-detailed' };
    if (pathname === '/dream-worlds/fragments') return { kind: 'fragment-list' };
    const fragment = pathname.match(/^\/dream-worlds\/fragments\/([^/]+)$/);
    if (fragment) return { kind: 'fragment-detail', slug: decode(fragment[1]) };
    const run = pathname.match(/^\/dream-worlds\/runs\/([^/]+)$/);
    if (run) return { kind: 'run-detail', run: decode(run[1]) };
    const invite = pathname.match(/^\/dream-worlds\/invites\/(\d+)\/(accept|decline)$/);
    if (invite) return { kind: 'invite-response', slotId: Number(invite[1]), action: invite[2] };
    return null;
}

function parseAdminPath(pathname) {
    if (pathname === '/admin/dream-worlds/runs') return { kind: 'admin-runs' };
    if (pathname === '/admin/dream-worlds/fragments') return { kind: 'admin-fragments' };

    const slot = pathname.match(/^\/admin\/dream-worlds\/runs\/([^/]+)\/slots\/(\d+)\/(invite|confirm|remove|replace)$/);
    if (slot) {
        return {
            kind: 'admin-slot-action',
            run: decode(slot[1]),
            slotId: Number(slot[2]),
            action: slot[3],
        };
    }

    const runAction = pathname.match(/^\/admin\/dream-worlds\/runs\/([^/]+)\/(start|advance|pause|resume|complete|fail|cancel)$/);
    if (runAction) return { kind: 'admin-run-action', run: decode(runAction[1]), action: runAction[2] };

    const runDetail = pathname.match(/^\/admin\/dream-worlds\/runs\/([^/]+)$/);
    if (runDetail) return { kind: 'admin-run-detail', run: decode(runDetail[1]) };

    const fragmentAction = pathname.match(/^\/admin\/dream-worlds\/fragments\/([^/]+)\/(update|grant)$/);
    if (fragmentAction) {
        return {
            kind: 'admin-fragment-action',
            fragment: decode(fragmentAction[1]),
            action: fragmentAction[2],
        };
    }
    return null;
}

function playerPathMatches(kind, action = null) {
    return (pathname) => {
        const route = parsePlayerPath(pathname);
        return route?.kind === kind && (action === null || route.action === action);
    };
}

function adminPathMatches(kind, action = null) {
    return (pathname) => {
        const route = parseAdminPath(pathname);
        return route?.kind === kind && (action === null || route.action === action);
    };
}

const DREAM_WORLDS_OPERATION_ROUTE_DESCRIPTORS = Object.freeze([
    routeDescriptor({ id: 'dream-worlds.dashboard', methods: ['GET'], template: '/dream-worlds/me', samplePath: '/dream-worlds/me', match: playerPathMatches('dashboard-detailed'), handlerOwner: 'handleDreamWorldsOperationsHttp', sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', authClass: 'SITE_SESSION', contractId: 'dream-dashboard-v1' }),
    routeDescriptor({ id: 'dream-worlds.fragments.list', methods: ['GET'], template: '/dream-worlds/fragments', samplePath: '/dream-worlds/fragments', match: playerPathMatches('fragment-list'), handlerOwner: 'handleDreamWorldsOperationsHttp', sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', authClass: 'PUBLIC', contractId: 'dream-fragment-list-v1' }),
    routeDescriptor({ id: 'dream-worlds.fragments.detail', methods: ['GET'], template: '/dream-worlds/fragments/:slug', samplePath: '/dream-worlds/fragments/example-fragment', match: playerPathMatches('fragment-detail'), handlerOwner: 'handleDreamWorldsOperationsHttp', sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', authClass: 'PUBLIC', contractId: 'dream-fragment-v1' }),
    routeDescriptor({ id: 'dream-worlds.runs.detail', methods: ['GET'], template: '/dream-worlds/runs/:runId', samplePath: '/dream-worlds/runs/example-run', match: playerPathMatches('run-detail'), handlerOwner: 'handleDreamWorldsOperationsHttp', sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', authClass: 'SITE_SESSION', contractId: 'dream-run-v1' }),
    routeDescriptor({ id: 'dream-worlds.invite.accept', methods: ['POST'], template: '/dream-worlds/invites/:slotId/accept', samplePath: '/dream-worlds/invites/1/accept', match: playerPathMatches('invite-response', 'accept'), handlerOwner: 'handleDreamWorldsOperationsHttp', sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', authClass: 'SITE_SESSION', contractId: 'dream-run-v1' }),
    routeDescriptor({ id: 'dream-worlds.invite.decline', methods: ['POST'], template: '/dream-worlds/invites/:slotId/decline', samplePath: '/dream-worlds/invites/1/decline', match: playerPathMatches('invite-response', 'decline'), handlerOwner: 'handleDreamWorldsOperationsHttp', sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', authClass: 'SITE_SESSION', contractId: 'dream-run-v1' }),
    routeDescriptor({ id: 'admin.dream-worlds.runs.list', methods: ['GET'], template: '/admin/dream-worlds/runs', samplePath: '/admin/dream-worlds/runs', match: adminPathMatches('admin-runs'), handlerOwner: 'handleDreamWorldsOperationsHttp', sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', authClass: 'ADMIN_CAPABILITY:raid.view', contractId: 'admin-dream-run-list-v1' }),
    routeDescriptor({ id: 'admin.dream-worlds.runs.detail', methods: ['GET'], template: '/admin/dream-worlds/runs/:runId', samplePath: '/admin/dream-worlds/runs/example-run', match: adminPathMatches('admin-run-detail'), handlerOwner: 'handleDreamWorldsOperationsHttp', sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', authClass: 'ADMIN_CAPABILITY:raid.view', contractId: 'admin-dream-run-v1' }),
    ...['invite', 'confirm', 'remove', 'replace'].map((action) => routeDescriptor({ id: `admin.dream-worlds.slot.${action}`, methods: ['POST'], template: `/admin/dream-worlds/runs/:runId/slots/:slotId/${action}`, samplePath: `/admin/dream-worlds/runs/example-run/slots/1/${action}`, match: adminPathMatches('admin-slot-action', action), handlerOwner: 'handleDreamWorldsOperationsHttp', sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', authClass: 'ADMIN_CAPABILITY:raid.manage', contractId: 'admin-dream-run-v1' })),
    ...['start', 'advance', 'pause', 'resume', 'complete', 'fail', 'cancel'].map((action) => routeDescriptor({ id: `admin.dream-worlds.run.${action}`, methods: ['POST'], template: `/admin/dream-worlds/runs/:runId/${action}`, samplePath: `/admin/dream-worlds/runs/example-run/${action}`, match: adminPathMatches('admin-run-action', action), handlerOwner: 'handleDreamWorldsOperationsHttp', sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', authClass: 'ADMIN_CAPABILITY:raid.manage', contractId: 'admin-dream-run-v1' })),
    routeDescriptor({ id: 'admin.dream-worlds.fragments.list', methods: ['GET'], template: '/admin/dream-worlds/fragments', samplePath: '/admin/dream-worlds/fragments', match: adminPathMatches('admin-fragments'), handlerOwner: 'handleDreamWorldsOperationsHttp', sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', authClass: 'ADMIN_CAPABILITY:catalog.view', contractId: 'admin-dream-fragment-list-v1' }),
    routeDescriptor({ id: 'admin.dream-worlds.fragments.create', methods: ['POST'], template: '/admin/dream-worlds/fragments', samplePath: '/admin/dream-worlds/fragments', match: adminPathMatches('admin-fragments'), handlerOwner: 'handleDreamWorldsOperationsHttp', sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', authClass: 'ADMIN_CAPABILITY:catalog.manage.rewards', contractId: 'admin-dream-fragment-v1' }),
    routeDescriptor({ id: 'admin.dream-worlds.fragments.update', methods: ['POST'], template: '/admin/dream-worlds/fragments/:slug/update', samplePath: '/admin/dream-worlds/fragments/example-fragment/update', match: adminPathMatches('admin-fragment-action', 'update'), handlerOwner: 'handleDreamWorldsOperationsHttp', sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', authClass: 'ADMIN_CAPABILITY:catalog.manage.rewards', contractId: 'admin-dream-fragment-v1' }),
    routeDescriptor({ id: 'admin.dream-worlds.fragments.grant', methods: ['POST'], template: '/admin/dream-worlds/fragments/:slug/grant', samplePath: '/admin/dream-worlds/fragments/example-fragment/grant', match: adminPathMatches('admin-fragment-action', 'grant'), handlerOwner: 'handleDreamWorldsOperationsHttp', sourceFile: 'helpers/clover/dreamWorldsOperationsHttp.js', authClass: 'ADMIN_CAPABILITY:reward.grant', contractId: 'admin-dream-fragment-v1' }),
]);

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

async function requireSession(db, req) {
    const auth = await authenticateSiteSession(db, bearerToken(req));
    if (!auth?.ok || !auth.player?.id) {
        const error = new Error('Sessão inválida ou expirada.');
        error.code = auth?.reason || 'invalid_session';
        error.status = 401;
        throw error;
    }
    return auth;
}

async function requireAdmin(db, req, capabilities = []) {
    const auth = await requireSession(db, req);
    const access = await getAdminActorAccess(db, auth.player.id);
    if (!access?.ok) {
        const error = new Error('Sua conta não possui acesso à Central ADM.');
        error.code = access?.code || 'admin_access_denied';
        error.status = 403;
        throw error;
    }
    for (const capability of capabilities) requireCapability(access, capability);
    return { auth, access };
}

function errorStatus(error) {
    if (Number(error?.status)) return Number(error.status);
    const notFound = new Set([
        'run_not_found', 'slot_not_found', 'player_not_found',
        'fragment_not_found', 'origin_world_not_found', 'origin_run_not_found',
    ]);
    const forbidden = new Set([
        'invite_forbidden', 'run_forbidden', 'squad_slot_forbidden',
        'admin_access_denied', 'missing_capability',
    ]);
    const conflict = new Set([
        'run_slots_locked', 'slot_not_open', 'slot_not_removable', 'slot_not_replaceable',
        'player_already_in_run', 'invite_not_pending', 'minimum_players_not_met',
        'run_not_startable', 'run_not_running', 'run_not_pausable', 'run_not_resumable',
        'run_not_finishable', 'run_not_cancellable', 'chapter_not_unlocked',
        'chapter_must_advance', 'fragment_slug_exists', 'fragment_already_owned',
    ]);
    if (notFound.has(error?.code)) return 404;
    if (forbidden.has(error?.code)) return 403;
    if (conflict.has(error?.code)) return 409;
    return 400;
}

async function handleDreamWorldsOperationsHttp(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const playerRoute = parsePlayerPath(url.pathname);
    const adminRoute = parseAdminPath(url.pathname);
    const descriptor = matchDescriptor(DREAM_WORLDS_OPERATION_ROUTE_DESCRIPTORS, method, url.pathname);
    const recognizedPath = descriptor || DREAM_WORLDS_OPERATION_ROUTE_DESCRIPTORS.some((route) => route.match(url.pathname));
    if (!recognizedPath) return false;

    setCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }

    const db = options.getDb?.();
    if (!db) {
        sendJson(res, 503, { ok: false, error: 'database_unavailable', message: 'O banco ainda não está pronto.' });
        return true;
    }

    try {
        if (playerRoute?.kind === 'dashboard-detailed') {
            if (method !== 'GET') return sendMethodNotAllowed(res);
            const auth = await requireSession(db, req);
            const dashboard = await getPlayerDreamDashboardDetailed(db, auth.player.id);
            sendJson(res, 200, { ok: true, dashboard, dreams: dashboard, data: dashboard });
            return true;
        }

        if (playerRoute?.kind === 'fragment-list') {
            if (method !== 'GET') return sendMethodNotAllowed(res);
            const fragments = await listPublicFragments(db, {
                category: url.searchParams.get('category'),
                status: url.searchParams.get('status'),
            });
            res.setHeader('Cache-Control', 'public, max-age=30');
            sendJson(res, 200, { ok: true, fragments, data: fragments });
            return true;
        }

        if (playerRoute?.kind === 'fragment-detail') {
            if (method !== 'GET') return sendMethodNotAllowed(res);
            const fragment = await getPublicFragmentBySlug(db, playerRoute.slug);
            res.setHeader('Cache-Control', 'public, max-age=30');
            sendJson(res, 200, { ok: true, fragment, data: fragment });
            return true;
        }

        if (playerRoute?.kind === 'run-detail') {
            if (method !== 'GET') return sendMethodNotAllowed(res);
            const auth = await requireSession(db, req);
            const run = await getPlayerDreamRun(db, playerRoute.run, auth.player.id);
            sendJson(res, 200, { ok: true, run, data: run });
            return true;
        }

        if (playerRoute?.kind === 'invite-response') {
            if (method !== 'POST') return sendMethodNotAllowed(res);
            const auth = await requireSession(db, req);
            const body = await readJsonBody(req);
            const run = await respondDreamInvite(db, playerRoute.slotId, auth.player.id, playerRoute.action, body);
            sendJson(res, 200, { ok: true, run, data: run });
            return true;
        }

        if (adminRoute?.kind === 'admin-runs') {
            if (method !== 'GET') return sendMethodNotAllowed(res);
            await requireAdmin(db, req, ['raid.view']);
            const runs = await listAdminDreamRuns(db, { status: url.searchParams.get('status') });
            sendJson(res, 200, { ok: true, runs, data: runs });
            return true;
        }

        if (adminRoute?.kind === 'admin-run-detail') {
            if (method !== 'GET') return sendMethodNotAllowed(res);
            await requireAdmin(db, req, ['raid.view']);
            const run = await getDreamRun(db, adminRoute.run);
            sendJson(res, 200, { ok: true, run, data: run });
            return true;
        }

        if (adminRoute?.kind === 'admin-slot-action') {
            if (method !== 'POST') return sendMethodNotAllowed(res);
            const admin = await requireAdmin(db, req, ['raid.manage']);
            const body = await readJsonBody(req);
            let run;
            if (adminRoute.action === 'invite' || adminRoute.action === 'confirm') {
                run = await assignDreamSlotWithPolicy(
                    db,
                    adminRoute.run,
                    adminRoute.slotId,
                    body.playerId || body.player_id,
                    admin.auth.player.id,
                    { ...body, mode: adminRoute.action === 'confirm' ? 'confirmed' : 'invited' }
                );
            } else if (adminRoute.action === 'remove') {
                run = await removeDreamSlot(db, adminRoute.run, adminRoute.slotId, admin.auth.player.id, body);
            } else {
                run = await replaceDreamSlotWithPolicy(
                    db,
                    adminRoute.run,
                    adminRoute.slotId,
                    body.playerId || body.player_id,
                    admin.auth.player.id,
                    body
                );
            }
            sendJson(res, 200, { ok: true, run, data: run });
            return true;
        }

        if (adminRoute?.kind === 'admin-run-action') {
            if (method !== 'POST') return sendMethodNotAllowed(res);
            const admin = await requireAdmin(db, req, ['raid.manage']);
            const body = await readJsonBody(req);
            const run = await transitionDreamRun(db, adminRoute.run, adminRoute.action, admin.auth.player.id, body);
            sendJson(res, 200, { ok: true, run, data: run });
            return true;
        }

        if (adminRoute?.kind === 'admin-fragments') {
            const admin = await requireAdmin(
                db,
                req,
                method === 'POST' ? ['catalog.manage.rewards'] : ['catalog.view']
            );
            if (method === 'GET') {
                const fragments = await listAdminFragments(db, {
                    category: url.searchParams.get('category'),
                    status: url.searchParams.get('status'),
                });
                sendJson(res, 200, { ok: true, fragments, data: fragments });
                return true;
            }
            if (method === 'POST') {
                const body = await readJsonBody(req);
                const fragment = await createResonanceFragment(db, body, admin.auth.player.id);
                sendJson(res, 201, { ok: true, fragment, data: fragment });
                return true;
            }
            return sendMethodNotAllowed(res);
        }

        if (adminRoute?.kind === 'admin-fragment-action') {
            if (method !== 'POST') return sendMethodNotAllowed(res);
            const capability = adminRoute.action === 'grant' ? 'reward.grant' : 'catalog.manage.rewards';
            const admin = await requireAdmin(db, req, [capability]);
            const body = await readJsonBody(req);
            const fragment = adminRoute.action === 'grant'
                ? await grantResonanceFragment(
                    db,
                    adminRoute.fragment,
                    body.playerId || body.player_id,
                    admin.auth.player.id,
                    body
                )
                : await updateResonanceFragment(db, adminRoute.fragment, body, admin.auth.player.id);
            sendJson(res, 200, { ok: true, fragment, data: fragment });
            return true;
        }

        return false;
    } catch (error) {
        const known = error instanceof DreamWorldsServiceError || error?.code || Number(error?.status);
        if (!known) throw error;
        sendJson(res, errorStatus(error), {
            ok: false,
            error: error?.code || 'dream_worlds_operations_error',
            message: error?.message || 'Não foi possível concluir a operação.',
            details: error?.details || null,
        });
        return true;
    }
}

function sendMethodNotAllowed(res) {
    sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
}

module.exports = {
    DREAM_WORLDS_OPERATION_ROUTE_DESCRIPTORS,
    handleDreamWorldsOperationsHttp,
    parseAdminPath,
    parsePlayerPath,
};
