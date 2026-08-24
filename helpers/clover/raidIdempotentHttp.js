'use strict';

const {
    RaidServiceError,
    addRaidHost,
    cancelRaid,
    cancelRaidReward,
    leaveRaid,
    removeRaidParticipant,
    resolveRaidCondition,
    revokeRaidHost,
    setRaidLoadoutSlot,
} = require('./raidService');
const { runEconomyMutationExclusive } = require('./economyMutationQueue');
const { authenticateSiteSession } = require('./siteAuthService');
const { matchDescriptor, routeDescriptor } = require('./httpRouteDescriptor');

function setCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Idempotency-Key, X-Request-Id, ngrok-skip-browser-warning'
    );
    res.setHeader('Access-Control-Allow-Methods', 'POST, PUT, OPTIONS');
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

function requestIdempotencyKey(req, body = {}) {
    return String(
        req.headers?.['idempotency-key']
        || body.idempotencyKey
        || body.idempotency_key
        || ''
    ).trim();
}

function raidMutationStatus(error) {
    if (!(error instanceof RaidServiceError)) return Number(error?.status || 500);
    const notFound = new Set([
        'raid_not_found',
        'player_not_found',
        'participant_not_found',
        'host_not_found',
        'item_not_found',
        'loadout_item_not_found',
    ]);
    const forbidden = new Set([
        'narrator_required',
        'raid_host_required',
        'principal_owner_required',
        'raid_forbidden',
        'loadout_forbidden',
        'game_blocked',
    ]);
    const conflict = new Set([
        'idempotency_conflict',
        'idempotency_in_progress',
        'idempotency_claim_lost',
        'raid_closed',
        'loadout_locked',
        'item_reserved',
        'insufficient_available_quantity',
        'reservation_conflict',
        'two_handed_conflict',
        'condition_not_active',
        'reward_not_editable',
    ]);
    if (notFound.has(error.code)) return 404;
    if (forbidden.has(error.code)) return 403;
    if (conflict.has(error.code)) return 409;
    return 400;
}

function parseRoute(pathname) {
    const path = String(pathname || '');
    const patterns = [
        ['host-revoke', /^\/raids\/([^/]+)\/hosts\/revoke$/],
        ['participant-remove', /^\/raids\/([^/]+)\/participants\/remove$/],
        ['condition-resolve', /^\/raids\/([^/]+)\/conditions\/([^/]+)\/resolve$/],
        ['reward-cancel', /^\/raids\/([^/]+)\/rewards\/([^/]+)\/cancel$/],
        ['loadout', /^\/raids\/([^/]+)\/loadout\/([^/]+)$/],
        ['host', /^\/raids\/([^/]+)\/hosts$/],
        ['leave', /^\/raids\/([^/]+)\/leave$/],
        ['raid-cancel', /^\/raids\/([^/]+)\/cancel$/],
    ];
    for (const [kind, pattern] of patterns) {
        const match = path.match(pattern);
        if (!match) continue;
        const route = {
            kind,
            raidKey: decodeURIComponent(match[1]),
        };
        if (kind === 'loadout') route.slot = decodeURIComponent(match[2]);
        if (kind === 'condition-resolve') route.conditionId = Number(decodeURIComponent(match[2]));
        if (kind === 'reward-cancel') route.rewardId = Number(decodeURIComponent(match[2]));
        return route;
    }
    return null;
}

function routeMethod(route) {
    return route?.kind === 'loadout' ? 'PUT' : 'POST';
}

function raidMutationPathMatches(kind) {
    return (pathname) => parseRoute(pathname)?.kind === kind;
}

const RAID_IDEMPOTENT_ROUTE_DESCRIPTORS = Object.freeze([
    routeDescriptor({ id: 'raid.host.add', methods: ['POST'], template: '/raids/:raidKey/hosts', samplePath: '/raids/example-raid/hosts', match: raidMutationPathMatches('host'), handlerOwner: 'handleRaidIdempotentHttp', sourceFile: 'helpers/clover/raidIdempotentHttp.js', authClass: 'SITE_SESSION:RAID_HOST', contractId: 'raid-host-v1', contractShapeId: 'raid-host-add-shape-v1' }),
    routeDescriptor({ id: 'raid.host.revoke', methods: ['POST'], template: '/raids/:raidKey/hosts/revoke', samplePath: '/raids/example-raid/hosts/revoke', match: raidMutationPathMatches('host-revoke'), handlerOwner: 'handleRaidIdempotentHttp', sourceFile: 'helpers/clover/raidIdempotentHttp.js', authClass: 'SITE_SESSION:RAID_HOST', contractId: 'raid-host-v1', contractShapeId: 'raid-host-revoke-shape-v1' }),
    routeDescriptor({ id: 'raid.participant.leave', methods: ['POST'], template: '/raids/:raidKey/leave', samplePath: '/raids/example-raid/leave', match: raidMutationPathMatches('leave'), handlerOwner: 'handleRaidIdempotentHttp', sourceFile: 'helpers/clover/raidIdempotentHttp.js', authClass: 'SITE_SESSION:RAID_PARTICIPANT', contractId: 'raid-participant-v1' }),
    routeDescriptor({ id: 'raid.participant.remove', methods: ['POST'], template: '/raids/:raidKey/participants/remove', samplePath: '/raids/example-raid/participants/remove', match: raidMutationPathMatches('participant-remove'), handlerOwner: 'handleRaidIdempotentHttp', sourceFile: 'helpers/clover/raidIdempotentHttp.js', authClass: 'SITE_SESSION:RAID_HOST', contractId: 'raid-participant-v1' }),
    routeDescriptor({ id: 'raid.condition.resolve', methods: ['POST'], template: '/raids/:raidKey/conditions/:conditionId/resolve', samplePath: '/raids/example-raid/conditions/1/resolve', match: raidMutationPathMatches('condition-resolve'), handlerOwner: 'handleRaidIdempotentHttp', sourceFile: 'helpers/clover/raidIdempotentHttp.js', authClass: 'SITE_SESSION:RAID_HOST', contractId: 'raid-condition-v1' }),
    routeDescriptor({ id: 'raid.reward.cancel', methods: ['POST'], template: '/raids/:raidKey/rewards/:rewardId/cancel', samplePath: '/raids/example-raid/rewards/1/cancel', match: raidMutationPathMatches('reward-cancel'), handlerOwner: 'handleRaidIdempotentHttp', sourceFile: 'helpers/clover/raidIdempotentHttp.js', authClass: 'SITE_SESSION:RAID_HOST', contractId: 'raid-reward-v1' }),
    routeDescriptor({ id: 'raid.cancel', methods: ['POST'], template: '/raids/:raidKey/cancel', samplePath: '/raids/example-raid/cancel', match: raidMutationPathMatches('raid-cancel'), handlerOwner: 'handleRaidIdempotentHttp', sourceFile: 'helpers/clover/raidIdempotentHttp.js', authClass: 'SITE_SESSION:RAID_HOST', contractId: 'raid-v1' }),
    routeDescriptor({ id: 'raid.loadout.slot.update', methods: ['PUT'], template: '/raids/:raidKey/loadout/:slot', samplePath: '/raids/example-raid/loadout/weapon', match: raidMutationPathMatches('loadout'), handlerOwner: 'handleRaidIdempotentHttp', sourceFile: 'helpers/clover/raidIdempotentHttp.js', authClass: 'SITE_SESSION:RAID_PARTICIPANT', contractId: 'raid-loadout-v1' }),
]);

async function handleRaidIdempotentHttp(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const route = parseRoute(url.pathname);
    const descriptor = matchDescriptor(RAID_IDEMPOTENT_ROUTE_DESCRIPTORS, method, url.pathname);
    if (!route || (!descriptor && method !== 'OPTIONS')) return false;

    setCors(req, res);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
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
        const body = await readJsonBody(req);
        const idempotencyKey = requestIdempotencyKey(req, body);
        const runner = options.mutationRunner || runEconomyMutationExclusive;

        if (route.kind === 'host') {
            const targetPlayerId = body.playerId || body.player_id;
            if (!targetPlayerId) {
                sendJson(res, 400, {
                    ok: false,
                    error: 'missing_player_id',
                    message: 'Informe playerId do co-host.',
                });
                return true;
            }
            const addHost = options.addRaidHost || addRaidHost;
            const result = await runner(
                () => addHost(
                    db,
                    route.raidKey,
                    auth.player.id,
                    targetPlayerId,
                    { idempotencyKey }
                ),
                { operation: `site:raid-host-add:${route.raidKey}` }
            );
            sendJson(res, 200, result);
            return true;
        }

        if (route.kind === 'host-revoke') {
            const targetPlayerId = body.playerId || body.player_id;
            if (!targetPlayerId) {
                sendJson(res, 400, {
                    ok: false,
                    error: 'missing_player_id',
                    message: 'Informe playerId do co-host.',
                });
                return true;
            }
            const revokeHost = options.revokeRaidHost || revokeRaidHost;
            const result = await runner(
                () => revokeHost(
                    db,
                    route.raidKey,
                    auth.player.id,
                    targetPlayerId,
                    { idempotencyKey }
                ),
                { operation: `site:raid-host-revoke:${route.raidKey}` }
            );
            sendJson(res, 200, result);
            return true;
        }

        if (route.kind === 'leave') {
            const leave = options.leaveRaid || leaveRaid;
            const result = await runner(
                () => leave(db, route.raidKey, auth.player.id, { idempotencyKey }),
                { operation: `site:raid-leave:${route.raidKey}` }
            );
            sendJson(res, 200, result);
            return true;
        }

        if (route.kind === 'participant-remove') {
            const targetPlayerId = body.playerId || body.player_id;
            if (!targetPlayerId) {
                sendJson(res, 400, {
                    ok: false,
                    error: 'missing_player_id',
                    message: 'Informe playerId do participante.',
                });
                return true;
            }
            const removeParticipant = options.removeRaidParticipant || removeRaidParticipant;
            const result = await runner(
                () => removeParticipant(
                    db,
                    route.raidKey,
                    auth.player.id,
                    targetPlayerId,
                    body.reason || body.motivo || null,
                    { idempotencyKey }
                ),
                { operation: `site:raid-participant-remove:${route.raidKey}` }
            );
            sendJson(res, 200, result);
            return true;
        }

        if (route.kind === 'condition-resolve') {
            const resolveCondition = options.resolveRaidCondition || resolveRaidCondition;
            const result = await runner(
                () => resolveCondition(
                    db,
                    route.raidKey,
                    auth.player.id,
                    route.conditionId,
                    body.note || body.observacao || null,
                    { idempotencyKey }
                ),
                { operation: `site:raid-condition-resolve:${route.raidKey}:${route.conditionId}` }
            );
            sendJson(res, 200, result);
            return true;
        }

        if (route.kind === 'reward-cancel') {
            const cancelReward = options.cancelRaidReward || cancelRaidReward;
            const result = await runner(
                () => cancelReward(
                    db,
                    route.raidKey,
                    auth.player.id,
                    route.rewardId,
                    { idempotencyKey }
                ),
                { operation: `site:raid-reward-cancel:${route.raidKey}:${route.rewardId}` }
            );
            sendJson(res, 200, result);
            return true;
        }

        if (route.kind === 'raid-cancel') {
            const cancel = options.cancelRaid || cancelRaid;
            const result = await runner(
                () => cancel(
                    db,
                    route.raidKey,
                    auth.player.id,
                    body.reason || body.motivo || null,
                    { idempotencyKey }
                ),
                { operation: `site:raid-cancel:${route.raidKey}` }
            );
            sendJson(res, 200, result);
            return true;
        }

        const setLoadout = options.setRaidLoadoutSlot || setRaidLoadoutSlot;
        const result = await runner(
            () => setLoadout(
                db,
                route.raidKey,
                auth.player.id,
                route.slot,
                {
                    ...body,
                    ...(idempotencyKey ? { idempotencyKey } : {}),
                }
            ),
            { operation: `site:raid-loadout:${route.raidKey}:${route.slot}` }
        );
        sendJson(res, 200, result);
        return true;
    } catch (error) {
        sendJson(res, raidMutationStatus(error), {
            ok: false,
            error: error?.code || 'raid_mutation_failed',
            message: error?.message || 'Não foi possível concluir a alteração da Raid.',
            details: error?.details || null,
        });
        return true;
    }
}

module.exports = {
    RAID_IDEMPOTENT_ROUTE_DESCRIPTORS,
    handleRaidIdempotentHttp,
    parseRoute,
    raidMutationStatus,
    requestIdempotencyKey,
    routeMethod,
};
