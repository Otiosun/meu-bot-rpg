'use strict';

const http = require('http');
const base = require('./siteApiServerBase');
const { handleAdminApiSupport } = require('./adminApiSupport');
const { handleCharacterPresentationPreview } = require('./characterPresentationPreviewHttp');
const { handleDreamWorldsHttp } = require('./dreamWorldsHttp');
const { handleDreamWorldsOperationsHttp } = require('./dreamWorldsOperationsHttp');
const {
    getPlayerRaidChecklist,
    getRaidCategoryCatalog,
    getRaidFinalizationSummary,
    setRaidParticipantFinalization,
} = require('./raidService');
const { authenticateSiteSession } = require('./siteAuthService');
const { getPublicReceptionState } = require('./receptionService');
const {
    getRaidCreationOptions,
    previewRaidMonthlyUsage,
} = require('./raidV2OptionsService');
const { getSquadOperations } = require('./siteSquadOperationsService');
const {
    SquadMembershipError,
    addSquadMember,
    removeSquadMember,
    searchSquadMemberCandidates,
} = require('./squadMembershipService');
const {
    RaidRewardProposalError,
    createRaidRewardProposal,
    listRaidRewardProposals,
} = require('./raidRewardProposalService');
const { runEconomyMutationExclusive } = require('./economyMutationQueue');
const {
    PrShopServiceError,
    getPrShopDashboard,
    purchasePrShopItem,
} = require('./prShopService');
const { handlePreResetSiteApi } = require('./preResetSiteApiService');
const { matchDescriptor, routeDescriptor } = require('./httpRouteDescriptor');

const LEGACY_PUBLIC_ROUTES = Object.freeze([
    routeDescriptor({ id: 'reception.read', methods: ['GET'], template: '/reception', samplePath: '/reception', match: (pathname) => pathname === '/reception' || pathname === '/recepcao', handlerOwner: 'handleReceptionSupport', sourceFile: 'helpers/clover/siteApiServerLegacy.js', authClass: 'PUBLIC_SAFE', contractId: 'reception-v1' }),
    routeDescriptor({ id: 'raid.categories.read', methods: ['GET'], template: '/raids/categories', samplePath: '/raids/categories', match: (pathname) => pathname === '/raids/categories' || pathname === '/raid-categories', handlerOwner: 'handleRaidCatalog', sourceFile: 'helpers/clover/siteApiServerLegacy.js', authClass: 'PUBLIC_SAFE', contractId: 'raid-categories-v1' }),
]);

const LEGACY_RAID_SUPPORT_ROUTE_DESCRIPTORS = Object.freeze([
    routeDescriptor({ id: 'raid.finalization.summary', methods: ['GET'], template: '/raids/:raidKey/finalization', samplePath: '/raids/example-raid/finalization', match: (pathname) => /^\/raids\/[^/]+\/finalization$/.test(String(pathname || '')), handlerOwner: 'handleRaidSupport', sourceFile: 'helpers/clover/siteApiServerLegacy.js', authClass: 'SITE_SESSION:RAID_PARTICIPANT', contractId: 'raid-finalization-summary-v1' }),
    routeDescriptor({ id: 'raid.options.read', methods: ['GET'], template: '/raids/options', samplePath: '/raids/options', match: (pathname) => pathname === '/raids/options', handlerOwner: 'handleRaidSupport', sourceFile: 'helpers/clover/siteApiServerLegacy.js', authClass: 'SITE_SESSION', contractId: 'raid-options-v1' }),
    routeDescriptor({ id: 'raid.usage.read', methods: ['GET'], template: '/raids/usage', samplePath: '/raids/usage', match: (pathname) => pathname === '/raids/usage', handlerOwner: 'handleRaidSupport', sourceFile: 'helpers/clover/siteApiServerLegacy.js', authClass: 'SITE_SESSION', contractId: 'raid-usage-v1' }),
    routeDescriptor({ id: 'raid.checklist.read', methods: ['GET'], template: '/raids/checklist', samplePath: '/raids/checklist', match: (pathname) => pathname === '/raids/checklist', handlerOwner: 'handleRaidSupport', sourceFile: 'helpers/clover/siteApiServerLegacy.js', authClass: 'SITE_SESSION', contractId: 'raid-checklist-v1' }),
]);

const LEGACY_RAID_REWARD_PROPOSAL_ROUTE_DESCRIPTORS = Object.freeze([
    routeDescriptor({ id: 'raid.reward-proposals.list', methods: ['GET'], template: '/raid-reward-proposals', samplePath: '/raid-reward-proposals', match: (pathname) => pathname === '/raid-reward-proposals', handlerOwner: 'handleRaidRewardProposalSupport', sourceFile: 'helpers/clover/siteApiServerLegacy.js', authClass: 'SITE_SESSION', contractId: 'raid-reward-proposal-list-v1' }),
    routeDescriptor({ id: 'raid.reward-proposals.create', methods: ['POST'], template: '/raids/:raidKey/reward-proposals', samplePath: '/raids/example-raid/reward-proposals', match: (pathname) => /^\/raids\/[^/]+\/reward-proposals$/.test(String(pathname || '')), handlerOwner: 'handleRaidRewardProposalSupport', sourceFile: 'helpers/clover/siteApiServerLegacy.js', authClass: 'SITE_SESSION:RAID_HOST', contractId: 'raid-reward-proposal-v1' }),
]);

const LEGACY_SQUAD_ROUTE_DESCRIPTORS = Object.freeze([
    routeDescriptor({ id: 'squad.operations.read', methods: ['GET'], template: '/squads/:squadKey/operations', samplePath: '/squads/example-squad/operations', match: (pathname) => /^\/squads\/[^/]+\/operations$/.test(String(pathname || '')), handlerOwner: 'handleSquadSupport', sourceFile: 'helpers/clover/siteApiServerLegacy.js', authClass: 'SITE_SESSION:SQUAD_MEMBER', contractId: 'squad-operations-v1' }),
    routeDescriptor({ id: 'squad.member-candidates.read', methods: ['GET'], template: '/squads/:squadKey/member-candidates', samplePath: '/squads/example-squad/member-candidates', match: (pathname) => /^\/squads\/[^/]+\/member-candidates$/.test(String(pathname || '')), handlerOwner: 'handleSquadCaptainSupport', sourceFile: 'helpers/clover/siteApiServerLegacy.js', authClass: 'SITE_SESSION:SQUAD_CAPTAIN', contractId: 'squad-member-candidate-list-v1' }),
    routeDescriptor({ id: 'squad.member.add', methods: ['POST'], template: '/squads/:squadKey/members', samplePath: '/squads/example-squad/members', match: (pathname) => /^\/squads\/[^/]+\/members$/.test(String(pathname || '')), handlerOwner: 'handleSquadCaptainSupport', sourceFile: 'helpers/clover/siteApiServerLegacy.js', authClass: 'SITE_SESSION:SQUAD_CAPTAIN', contractId: 'squad-member-v1' }),
    routeDescriptor({ id: 'squad.member.remove', methods: ['POST'], template: '/squads/:squadKey/members/:playerId/remove', samplePath: '/squads/example-squad/members/player-example/remove', match: (pathname) => /^\/squads\/[^/]+\/members\/[^/]+\/remove$/.test(String(pathname || '')), handlerOwner: 'handleSquadCaptainSupport', sourceFile: 'helpers/clover/siteApiServerLegacy.js', authClass: 'SITE_SESSION:SQUAD_CAPTAIN', contractId: 'squad-member-v1' }),
]);

const RECRUITMENT_SHOP_ROUTE_DESCRIPTORS = Object.freeze([
    routeDescriptor({ id: 'recruitment.shop.read', methods: ['GET'], template: '/recruitment/shop', samplePath: '/recruitment/shop', match: (pathname) => pathname === '/recruitment/shop', handlerOwner: 'handlePrShopSupport', sourceFile: 'helpers/clover/siteApiServerLegacy.js', authClass: 'SITE_SESSION', contractId: 'recruitment-shop-v1' }),
    routeDescriptor({ id: 'recruitment.shop.purchase', methods: ['POST'], template: '/recruitment/shop/:itemKey/purchase', samplePath: '/recruitment/shop/example-item/purchase', match: (pathname) => /^\/recruitment\/shop(?:\/[^/]+)?\/purchase$/.test(String(pathname || '')), handlerOwner: 'handlePrShopSupport', sourceFile: 'helpers/clover/siteApiServerLegacy.js', authClass: 'SITE_SESSION:IDEMPOTENCY_KEY', contractId: 'recruitment-shop-purchase-v1' }),
]);

function setPublicCors(req, res) {
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

async function requireSiteSession(db, req) {
    const auth = await authenticateSiteSession(db, bearerToken(req));
    if (!auth.ok) {
        const error = new Error('Sessão inválida ou expirada.');
        error.status = 401;
        error.code = auth.reason || 'invalid_token';
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

async function handleReceptionSupport(req, res, options) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    if (!LEGACY_PUBLIC_ROUTES.find((route) => route.id === 'reception.read')?.match(url.pathname)) return false;

    setPublicCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }
    if (method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return true;
    }

    const db = options.getDb?.();
    if (!db) {
        sendJson(res, 503, {
            ok: false,
            error: 'database_unavailable',
            message: 'A recepção está sendo preparada. Tente novamente em instantes.',
        });
        return true;
    }

    const reception = await getPublicReceptionState(db);
    res.setHeader('Cache-Control', 'public, max-age=30');
    sendJson(res, 200, { ok: true, reception, recepcao: reception });
    return true;
}

function handleRaidCatalog(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    if (!LEGACY_PUBLIC_ROUTES.find((route) => route.id === 'raid.categories.read')?.match(url.pathname)) return false;
    setPublicCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }
    if (method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return true;
    }
    const categories = getRaidCategoryCatalog();
    res.setHeader('Cache-Control', 'public, max-age=60');
    sendJson(res, 200, { ok: true, categories, categorias: categories });
    return true;
}

async function handlePrShopSupport(req, res, options) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const descriptor = matchDescriptor(RECRUITMENT_SHOP_ROUTE_DESCRIPTORS, method, url.pathname);
    const route = descriptor || RECRUITMENT_SHOP_ROUTE_DESCRIPTORS.find((item) => item.match(url.pathname));
    const purchaseMatch = route?.id === 'recruitment.shop.purchase'
        ? url.pathname.match(/^\/recruitment\/shop(?:\/([^/]+))?\/purchase$/)
        : null;
    const isDashboard = route?.id === 'recruitment.shop.read';
    if (!route) return false;

    setPublicCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }
    if ((isDashboard && method !== 'GET') || (purchaseMatch && method !== 'POST')) {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return true;
    }

    const db = options.getDb?.();
    if (!db) {
        sendJson(res, 503, { ok: false, error: 'database_unavailable', message: 'Banco ainda não está pronto.' });
        return true;
    }
    const auth = await requireSiteSession(db, req);

    try {
        if (isDashboard) {
            const dashboard = await runEconomyMutationExclusive(
                () => getPrShopDashboard(db, auth.player.id),
                { operation: 'site:pr-shop-dashboard' }
            );
            sendJson(res, 200, {
                ok: true,
                shop: dashboard,
                loja: dashboard,
                items: dashboard.items,
                itens: dashboard.items,
            });
            return true;
        }

        const body = await readJsonBody(req);
        const itemKey = decodeURIComponent(purchaseMatch[1] || body.itemKey || body.item_key || body.codigo || '');
        const idempotencyKey = String(
            req.headers['idempotency-key']
            || body.idempotencyKey
            || body.idempotency_key
            || ''
        ).trim();
        if (!itemKey) {
            sendJson(res, 400, { ok: false, error: 'missing_item_key', message: 'Informe a oferta da Loja de PR.' });
            return true;
        }
        if (!idempotencyKey) {
            sendJson(res, 400, { ok: false, error: 'missing_idempotency_key', message: 'Envie Idempotency-Key para comprar.' });
            return true;
        }
        const purchase = await runEconomyMutationExclusive(
            () => purchasePrShopItem(db, auth.player.id, itemKey, body.quantity || body.quantidade || 1, {
                idempotencyKey,
                createdBy: auth.player.id,
                via: 'site',
            }),
            { operation: `site:pr-shop-purchase:${itemKey}` }
        );
        sendJson(res, purchase.duplicate ? 200 : 201, {
            ok: true,
            purchase,
            compra: purchase,
            shop: purchase.dashboard,
            loja: purchase.dashboard,
        });
        return true;
    } catch (error) {
        if (!(error instanceof PrShopServiceError) && error?.name !== 'PrServiceError') throw error;
        const conflict = new Set(['weekly_limit', 'one_time_limit', 'global_stock', 'idempotency_conflict', 'shop_not_active']);
        const forbidden = new Set(['game_blocked']);
        const notFound = new Set(['shop_item_not_found', 'player_not_found']);
        const status = forbidden.has(error.code) ? 403 : notFound.has(error.code) ? 404 : conflict.has(error.code) ? 409 : 400;
        sendJson(res, status, {
            ok: false,
            error: error.code || 'pr_shop_error',
            message: error.message,
            details: error.details || null,
        });
        return true;
    }
}

function raidSupportStatus(error) {
    const forbidden = new Set(['raid_host_required', 'raid_forbidden']);
    const notFound = new Set(['raid_not_found', 'participant_not_active']);
    const conflict = new Set([
        'raid_not_in_finalization',
        'raid_eligibility_pending',
        'reward_without_eligible_target',
    ]);
    if (forbidden.has(error?.code)) return 403;
    if (notFound.has(error?.code)) return 404;
    if (conflict.has(error?.code)) return 409;
    return Number(error?.status || 400);
}

function captainSupportStatus(error) {
    const forbidden = new Set(['forbidden', 'self_review_blocked', 'raid_host_required']);
    const notFound = new Set(['squad_not_found', 'player_not_found', 'raid_not_found', 'proposal_not_found']);
    const conflict = new Set([
        'already_in_other_squad',
        'not_squad_member',
        'empty_reward_proposal',
        'proposal_not_pending',
        'proposal_stale',
        'active_membership_conflict',
        'membership_legacy_conflict',
    ]);
    if (forbidden.has(error?.code)) return 403;
    if (notFound.has(error?.code)) return 404;
    if (conflict.has(error?.code)) return 409;
    return Number(error?.status || 400);
}

async function handleRaidSupport(req, res, options) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const finalizationMatch = url.pathname.match(/^\/raids\/([^/]+)\/finalization$/);
    const participantReviewMatch = url.pathname.match(
        /^\/raids\/([^/]+)\/finalization\/participants\/([^/]+)$/
    );
    const descriptor = matchDescriptor(LEGACY_RAID_SUPPORT_ROUTE_DESCRIPTORS, method, url.pathname);
    const supportRoute = descriptor || LEGACY_RAID_SUPPORT_ROUTE_DESCRIPTORS.find((route) => route.match(url.pathname));
    if (!supportRoute && !participantReviewMatch) return false;

    setPublicCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }

    const db = options.getDb?.();
    if (!db) {
        sendJson(res, 503, { ok: false, error: 'database_unavailable', message: 'Banco ainda não está pronto.' });
        return true;
    }

    const auth = await requireSiteSession(db, req);
    try {
        if (finalizationMatch) {
            if (method !== 'GET') {
                sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
                return true;
            }
            const raidKey = decodeURIComponent(finalizationMatch[1]);
            const finalization = await getRaidFinalizationSummary(db, raidKey, auth.player.id);
            sendJson(res, 200, { ok: true, finalization, finalizacao: finalization });
            return true;
        }

        if (participantReviewMatch) {
            if (method !== 'POST') {
                sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
                return true;
            }
            const body = await readJsonBody(req);
            const raidKey = decodeURIComponent(participantReviewMatch[1]);
            const targetPlayerId = decodeURIComponent(participantReviewMatch[2]);
            const result = await runEconomyMutationExclusive(
                () => setRaidParticipantFinalization(
                    db,
                    raidKey,
                    auth.player.id,
                    targetPlayerId,
                    body
                ),
                { operation: `site:raid-finalization-review:${raidKey}` }
            );
            sendJson(res, 200, result);
            return true;
        }

        if (method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
            return true;
        }

        if (supportRoute?.id === 'raid.checklist.read') {
            const checklist = await getPlayerRaidChecklist(db, auth.player.id, {
                monthKey: url.searchParams.get('monthKey') || undefined,
            });
            sendJson(res, 200, {
                ok: true,
                checklist,
                progresso: checklist,
            });
            return true;
        }

        if (supportRoute?.id === 'raid.options.read') {
            const optionsPayload = await getRaidCreationOptions(db, auth.player.id);
            sendJson(res, 200, { ok: true, options: optionsPayload, ...optionsPayload });
            return true;
        }

        const preview = await previewRaidMonthlyUsage(db, auth.player.id, {
            category: url.searchParams.get('category'),
            scopePlayerId: url.searchParams.get('scopePlayerId'),
            scopeSquadKey: url.searchParams.get('scopeSquadKey'),
        });
        sendJson(res, 200, { ok: true, preview });
        return true;
    } catch (error) {
        sendJson(res, raidSupportStatus(error), {
            ok: false,
            error: error?.code || 'raid_support_error',
            message: error?.message || 'Não foi possível concluir a ação da raid.',
            details: error?.details || null,
        });
        return true;
    }
}

async function handleSquadSupport(req, res, options) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const descriptor = matchDescriptor(LEGACY_SQUAD_ROUTE_DESCRIPTORS, method, url.pathname);
    const route = descriptor || LEGACY_SQUAD_ROUTE_DESCRIPTORS.find((item) => item.match(url.pathname));
    const match = route?.id === 'squad.operations.read'
        ? url.pathname.match(/^\/squads\/([^/]+)\/operations$/)
        : null;
    if (!match) return false;

    setPublicCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }
    if (method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return true;
    }

    const db = options.getDb?.();
    if (!db) {
        sendJson(res, 503, { ok: false, error: 'database_unavailable', message: 'Banco ainda não está pronto.' });
        return true;
    }

    const auth = await requireSiteSession(db, req);
    const operations = await getSquadOperations(db, {
        actorId: auth.player.id,
        squadInput: decodeURIComponent(match[1]),
    });
    if (!operations.ok) {
        const status = operations.code === 'squad_not_found' ? 404 : 403;
        sendJson(res, status, {
            ok: false,
            error: operations.code,
            message: status === 404 ? 'Esquadrão não encontrado.' : 'Sua sessão não pode consultar este esquadrão.',
        });
        return true;
    }

    sendJson(res, 200, { ok: true, operations, operacoes: operations });
    return true;
}

async function handleSquadCaptainSupport(req, res, options) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const descriptor = matchDescriptor(LEGACY_SQUAD_ROUTE_DESCRIPTORS, method, url.pathname);
    const route = descriptor || LEGACY_SQUAD_ROUTE_DESCRIPTORS.find((item) => item.match(url.pathname));
    const candidatesMatch = route?.id === 'squad.member-candidates.read'
        ? url.pathname.match(/^\/squads\/([^/]+)\/member-candidates$/)
        : null;
    const addMemberMatch = route?.id === 'squad.member.add'
        ? url.pathname.match(/^\/squads\/([^/]+)\/members$/)
        : null;
    const removeMemberMatch = route?.id === 'squad.member.remove'
        ? url.pathname.match(/^\/squads\/([^/]+)\/members\/([^/]+)\/remove$/)
        : null;
    if (!route) return false;

    // GET /squads/:key/members belongs to the read-only member directory
    // implemented by siteApiServerBase. Only POST is handled here.
    if (addMemberMatch && method === 'GET') return false;

    setPublicCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }
    if ((candidatesMatch && method !== 'GET') || ((addMemberMatch || removeMemberMatch) && method !== 'POST')) {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return true;
    }

    const db = options.getDb?.();
    if (!db) {
        sendJson(res, 503, { ok: false, error: 'database_unavailable', message: 'Banco ainda não está pronto.' });
        return true;
    }

    const auth = await requireSiteSession(db, req);
    try {
        if (candidatesMatch) {
            const result = await searchSquadMemberCandidates(db, {
                actorId: auth.player.id,
                squadInput: decodeURIComponent(candidatesMatch[1]),
                query: url.searchParams.get('q') || '',
            });
            sendJson(res, 200, { ok: true, candidates: result.candidates });
            return true;
        }
        if (addMemberMatch) {
            const body = await readJsonBody(req);
            const result = await addSquadMember(db, {
                actorId: auth.player.id,
                squadInput: decodeURIComponent(addMemberMatch[1]),
                characterId: body.characterId || body.character_id,
            });
            sendJson(res, result.duplicate ? 200 : 201, result);
            return true;
        }
        const body = await readJsonBody(req);
        const result = await removeSquadMember(db, {
            actorId: auth.player.id,
            squadInput: decodeURIComponent(removeMemberMatch[1]),
            characterId: decodeURIComponent(removeMemberMatch[2]),
            reason: body.reason || body.motivo,
        });
        sendJson(res, 200, result);
        return true;
    } catch (error) {
        if (!(error instanceof SquadMembershipError)) throw error;
        sendJson(res, captainSupportStatus(error), {
            ok: false,
            error: error.code,
            message: error.message,
            details: error.details || null,
        });
        return true;
    }
}

async function handleRaidRewardProposalSupport(req, res, options) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const descriptor = matchDescriptor(LEGACY_RAID_REWARD_PROPOSAL_ROUTE_DESCRIPTORS, method, url.pathname);
    const proposalRoute = descriptor || LEGACY_RAID_REWARD_PROPOSAL_ROUTE_DESCRIPTORS.find((route) => route.match(url.pathname));
    if (!proposalRoute) return false;
    const createMatch = proposalRoute.id === 'raid.reward-proposals.create'
        ? url.pathname.match(/^\/raids\/([^/]+)\/reward-proposals$/)
        : null;

    setPublicCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }
    if ((proposalRoute.id === 'raid.reward-proposals.list' && method !== 'GET') || (createMatch && method !== 'POST')) {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        return true;
    }

    const db = options.getDb?.();
    if (!db) {
        sendJson(res, 503, { ok: false, error: 'database_unavailable', message: 'Banco ainda não está pronto.' });
        return true;
    }

    const auth = await requireSiteSession(db, req);
    try {
        if (proposalRoute.id === 'raid.reward-proposals.list') {
            const proposals = await listRaidRewardProposals(db, {
                actorId: auth.player.id,
                status: url.searchParams.get('status') || 'pending',
            });
            sendJson(res, 200, { ok: true, proposals });
            return true;
        }
        if (createMatch) {
            const body = await readJsonBody(req);
            const result = await createRaidRewardProposal(db, {
                raidKey: decodeURIComponent(createMatch[1]),
                actorId: auth.player.id,
                metadata: body.metadata || {},
            });
            sendJson(res, result.duplicate ? 200 : 201, result);
            return true;
        }
        return false;
    } catch (error) {
        if (!(error instanceof RaidRewardProposalError) && error?.name !== 'RaidServiceError') throw error;
        sendJson(res, captainSupportStatus(error), {
            ok: false,
            error: error.code || 'raid_reward_proposal_error',
            message: error.message,
            details: error.details || null,
        });
        return true;
    }
}

function startSiteApiServer(options = {}) {
    const originalCreateServer = http.createServer;
    http.createServer = function createRaidV2AwareServer(listener) {
        return originalCreateServer.call(http, (req, res) => {
            Promise.resolve()
                .then(async () => {
                    if (await handleAdminApiSupport(req, res, options)) return true;
                    if (await handleCharacterPresentationPreview(req, res, options)) return true;
                    if (await handleDreamWorldsOperationsHttp(req, res, options)) return true;
                    if (await handleDreamWorldsHttp(req, res, options)) return true;
                    if (await handlePreResetSiteApi(req, res, options)) return true;
                    if (await handleReceptionSupport(req, res, options)) return true;
                    if (handleRaidCatalog(req, res)) return true;
                    if (await handlePrShopSupport(req, res, options)) return true;
                    if (await handleRaidSupport(req, res, options)) return true;
                    if (await handleRaidRewardProposalSupport(req, res, options)) return true;
                    if (await handleSquadCaptainSupport(req, res, options)) return true;
                    return handleSquadSupport(req, res, options);
                })
                .then((handled) => {
                    if (!handled) listener(req, res);
                })
                .catch((error) => {
                    if (res.headersSent) {
                        res.end();
                        return;
                    }
                    sendJson(res, Number(error?.status || 500), {
                        ok: false,
                        error: error?.code || 'site_support_error',
                        message: error?.message || 'Erro ao carregar dados do site.',
                    });
                });
        });
    };
    try {
        return base.startSiteApiServer(options);
    } finally {
        http.createServer = originalCreateServer;
    }
}

module.exports = {
    LEGACY_SQUAD_ROUTE_DESCRIPTORS,
    RECRUITMENT_SHOP_ROUTE_DESCRIPTORS,
    LEGACY_RAID_REWARD_PROPOSAL_ROUTE_DESCRIPTORS,
    LEGACY_RAID_SUPPORT_ROUTE_DESCRIPTORS,
    ...base,
    handleAdminApiSupport,
    handleCharacterPresentationPreview,
    handleDreamWorldsHttp,
    handleDreamWorldsOperationsHttp,
    handlePrShopSupport,
    handlePreResetSiteApi,
    handleRaidRewardProposalSupport,
    handleRaidSupport,
    handleReceptionSupport,
    handleSquadCaptainSupport,
    handleSquadSupport,
    startSiteApiServer,
};
