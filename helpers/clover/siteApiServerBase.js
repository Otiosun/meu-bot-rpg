const crypto = require('crypto');
const http = require('http');
const { AsyncLocalStorage } = require('async_hooks');
const { matchDescriptor } = require('./httpRouteDescriptor');
const { SITE_API_BASE_AUTHED_ROUTE_DESCRIPTORS, SITE_API_BASE_PUBLIC_ROUTE_DESCRIPTORS } = require('./siteApiBaseRouteDescriptors');

const { getAttributeValues, getCharacterStats, getPbUsage, validateDistribution, savePendingDistribution, confirmPendingDistribution } = require('./characterStats');
const { getCharacterBonusSummary } = require('./characterBonusService');
const { getCavalierSummary, getInventoryItems } = require('./cavalierService');
const {
    buildProfileCapacitySummary,
    getPlayerTechnicalCapacity,
} = require('./capacityService');
const {
    confirmPendingHexagonUpgrade,
    createPendingHexagonUpgrade,
    getHexagonDerivedLimits,
    getOrCreateHexagon,
} = require('./hexagonService');
const { getPlayerPhase } = require('./playerPhase');
const { getPhHistory, getPhSummary } = require('./phService');
const {
    BoxServiceError,
    getBoxDashboard,
    getBoxHistory,
    openBox,
} = require('./boxService');
const { InventoryServiceError, getStructuredInventory } = require('./inventoryService');
const {
    EconomyServiceError,
    cancelPurchase,
    confirmNpcSale,
    confirmPurchase,
    confirmRepair,
    getEconomyDashboard,
    getSalaryDashboard,
    getShopCatalog,
    grantInitialPackage,
    listShops,
    previewNpcSale,
    previewPurchase,
    previewRepair,
    useConsumable,
} = require('./economyService');
const {
    MarketServiceError,
    cancelMarketListing,
    cancelMarketPurchase,
    cancelPayment,
    cancelSecureTrade,
    cancelWeeklyNpcRequest,
    confirmMarketPurchase,
    confirmPayment,
    confirmSecureTrade,
    createMarketListing,
    createSecureTrade,
    createWeeklyNpcRequest,
    fulfillWeeklyNpcRequest,
    getMarketDashboard,
    listMarket,
    listTrades,
    listWeeklyNpcRequests,
    placeAuctionBid,
    previewMarketPurchase,
    quoteMarketListing,
    previewPayment,
    updateTradeSide,
    updateWeeklyNpcRequest,
} = require('./marketService');
const {
    ItemAdminServiceError,
    archiveItemTemplate,
    createItemTemplate,
    grantItemCopies,
    listItemTemplates,
    updateItemTemplate,
} = require('./itemAdminService');
const {
    ItemRedemptionServiceError,
    cancelItemRedemption,
    listOwnItemRedemptions,
    listPendingItemRedemptions,
    requestItemRedemption,
    resolveItemRedemption,
} = require('./itemRedemptionService');
const { TitleServiceError, activatePlayerTitle, deactivatePlayerTitle, listPlayerTitles } = require('./titleService');
const { getPrHistory, getPrSummary } = require('./prService');
const {
    RaidServiceError,
    addRaidCondition,
    addRaidHost,
    addRaidReward,
    applyRaidDurabilityLoss,
    beginRaidFinalization,
    cancelRaid,
    cancelRaidReward,
    completeRaid,
    consumeRaidItem,
    createRaid,
    getRaidDashboard,
    getRaidParticipantDetail,
    joinRaid,
    leaveRaid,
    listActorRaids,
    removeRaidParticipant,
    resolveRaidCondition,
    revokeRaidHost,
    setRaidLoadoutSlot,
    startRaid,
} = require('./raidService');
const {
    RecruitmentServiceError,
    getRecruitmentDashboard,
    submitReferralCode,
} = require('./recruitmentService');
const { getYullsHistory, getYullsSummary } = require('./yullsService');
const {
    ProfileImageServiceError,
    saveProfileImage,
} = require('./profileImageService');
const { getSiteSpellbook } = require('./siteSpellbookService');
const {
    EconomyQueueTimeoutError,
    getEconomyQueueState,
    runEconomyMutationExclusive,
} = require('./economyMutationQueue');
const { buyNode, getTreeState } = require('./skillTreeService');
const { listTrees } = require('./treeLoader');
const {
    authenticateSiteSession,
    loginWithSiteCode,
    revokeSiteSession,
} = require('./siteAuthService');
const { buildSiteAccessPayload } = require('./siteAccessPayloadService');
const { getSquadMemberDirectory } = require('./siteSquadMemberService');
const { getSiteSquadUpgradeCatalog } = require('./siteSquadUpgradePayloadService');

let activeServer = null;
let activeOptions = null;
let retryTimer = null;
const requestContext = new AsyncLocalStorage();

const CORS_HEADERS = 'Content-Type, Authorization, Idempotency-Key, X-Request-Id, ngrok-skip-browser-warning';

class HttpError extends Error {
    constructor(status, code, message, details = null) {
        super(message || code);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

function recruitmentHttpError(error) {
    if (!(error instanceof RecruitmentServiceError)) return error;
    const conflictCodes = new Set([
        'event_not_active',
        'referral_window_expired',
        'referral_already_submitted',
        'activation_date_missing',
    ]);
    const notFoundCodes = new Set(['code_not_found', 'player_not_found']);
    const status = conflictCodes.has(error.code) ? 409 : notFoundCodes.has(error.code) ? 404 : 400;
    return new HttpError(status, error.code, error.message, error.details || null);
}

function boxHttpError(error) {
    if (!(error instanceof BoxServiceError)) return error;
    const notFoundCodes = new Set(['box_not_found', 'box_not_owned']);
    const conflictCodes = new Set(['idempotency_conflict']);
    const status = notFoundCodes.has(error.code) ? 404 : conflictCodes.has(error.code) ? 409 : 400;
    return new HttpError(status, error.code, error.message, error.details || null);
}

function raidHttpError(error) {
    if (error instanceof InventoryServiceError) {
        const conflictCodes = new Set([
            'item_reserved', 'insufficient_available_quantity', 'reservation_conflict',
            'reservation_quantity_exceeded',
        ]);
        const status = conflictCodes.has(error.code) ? 409 : error.code === 'item_not_found' ? 404 : 400;
        return new HttpError(status, error.code, error.message, error.details || null);
    }
    if (!(error instanceof RaidServiceError)) return error;
    const notFoundCodes = new Set([
        'raid_not_found', 'player_not_found', 'participant_not_found', 'host_not_found',
        'item_not_found', 'loadout_item_not_found', 'reward_template_not_found',
    ]);
    const forbiddenCodes = new Set([
        'narrator_required', 'raid_host_required', 'principal_owner_required',
        'raid_forbidden', 'loadout_forbidden', 'game_blocked',
    ]);
    const conflictCodes = new Set([
        'raid_already_started', 'raid_full', 'loadout_locked', 'participant_in_another_raid',
        'raid_not_in_progress', 'raid_not_in_finalization', 'rewards_locked',
        'raid_completed', 'item_reserved', 'insufficient_available_quantity',
    ]);
    const status = notFoundCodes.has(error.code)
        ? 404
        : forbiddenCodes.has(error.code)
            ? 403
            : conflictCodes.has(error.code)
                ? 409
                : 400;
    return new HttpError(status, error.code, error.message, error.details || null);
}

function economyHttpError(error) {
    if (error instanceof ItemRedemptionServiceError || error instanceof TitleServiceError) {
        const notFoundCodes = new Set(['item_not_found', 'title_not_found']);
        const conflictCodes = new Set(['item_not_available', 'redemption_not_pending']);
        const status = notFoundCodes.has(error.code) ? 404 : conflictCodes.has(error.code) ? 409 : 400;
        return new HttpError(status, error.code, error.message, error.details || null);
    }
    if (error instanceof InventoryServiceError || error?.name === 'YullsServiceError') {
        const conflictCodes = new Set([
            'item_reserved', 'insufficient_available_quantity', 'reservation_conflict',
            'insufficient_available_yulls', 'insufficient_yulls',
        ]);
        const notFoundCodes = new Set(['item_not_found', 'player_not_found']);
        const status = notFoundCodes.has(error.code) ? 404 : conflictCodes.has(error.code) ? 409 : 400;
        return new HttpError(status, error.code, error.message, error.details || null);
    }
    if (!(error instanceof EconomyServiceError)) return error;
    const notFoundCodes = new Set([
        'shop_not_found', 'listing_not_found', 'purchase_not_found', 'sale_not_found',
        'repair_not_found', 'item_not_found', 'player_not_found',
    ]);
    const conflictCodes = new Set([
        'stock_unavailable', 'weekly_purchase_limit', 'purchase_not_pending',
        'sale_not_pending', 'repair_not_pending', 'item_not_available',
        'return_window_closed', 'repair_not_needed',
    ]);
    const forbiddenCodes = new Set(['game_blocked', 'listing_requires_release']);
    const status = notFoundCodes.has(error.code)
        ? 404
        : forbiddenCodes.has(error.code)
            ? 403
            : conflictCodes.has(error.code)
                ? 409
                : 400;
    return new HttpError(status, error.code, error.message, error.details || null);
}

function marketHttpError(error) {
    if (error instanceof InventoryServiceError || error?.name === 'YullsServiceError') {
        const conflictCodes = new Set([
            'item_reserved', 'insufficient_available_quantity', 'reservation_conflict',
            'insufficient_available_yulls', 'insufficient_yulls',
        ]);
        const notFoundCodes = new Set(['item_not_found', 'player_not_found']);
        const status = notFoundCodes.has(error.code) ? 404 : conflictCodes.has(error.code) ? 409 : 400;
        return new HttpError(status, error.code, error.message, error.details || null);
    }
    if (error instanceof ItemAdminServiceError) {
        const notFoundCodes = new Set(['item_template_not_found', 'player_not_found']);
        const forbiddenCodes = new Set(['item_manager_required', 'static_item_locked']);
        const conflictCodes = new Set(['unique_item_exists', 'unique_item_quantity', 'item_template_exists']);
        const status = notFoundCodes.has(error.code)
            ? 404
            : forbiddenCodes.has(error.code)
                ? 403
                : conflictCodes.has(error.code)
                    ? 409
                    : 400;
        return new HttpError(status, error.code, error.message, error.details || null);
    }
    if (!(error instanceof MarketServiceError)) return error;
    const notFoundCodes = new Set([
        'player_not_found', 'item_not_found', 'listing_not_found', 'payment_not_found',
        'market_purchase_not_found', 'trade_not_found', 'trade_item_not_found',
    ]);
    const forbiddenCodes = new Set(['listing_owner_required', 'trade_actor_required']);
    const conflictCodes = new Set([
        'listing_not_available', 'listing_quantity_unavailable', 'market_purchase_not_pending',
        'auction_not_active', 'auction_has_bid', 'trade_not_pending', 'trade_item_unavailable',
        'trade_item_quantity_unavailable', 'weekly_request_not_active',
        'weekly_request_personal_limit', 'weekly_request_global_limit', 'weekly_request_arbitrage',
    ]);
    const status = notFoundCodes.has(error.code)
        ? 404
        : forbiddenCodes.has(error.code)
            ? 403
            : conflictCodes.has(error.code)
                ? 409
                : 400;
    return new HttpError(status, error.code, error.message, error.details || null);
}

function requestIdempotencyKey(req, body = {}) {
    return String(
        req.headers['idempotency-key']
        || body.idempotencyKey
        || body.idempotency_key
        || ''
    ).trim();
}

function isSiteApiEnabled() {
    return ['1', 'true', 'yes', 'on'].includes(String(process.env.CLOVER_SITE_API_ENABLED || '').toLowerCase());
}

function siteApiPort() {
    return Number(process.env.CLOVER_SITE_API_PORT || 8787);
}

function siteApiHost() {
    return process.env.CLOVER_SITE_API_HOST || '0.0.0.0';
}

function siteApiQueueWaitMs() {
    const configured = Number(process.env.CLOVER_SITE_QUEUE_WAIT_MS || 8000);
    if (!Number.isFinite(configured)) return 8000;
    return Math.max(1000, Math.min(30000, Math.floor(configured)));
}

function safeRequestPath(req) {
    try {
        return new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
        return '/invalid-url';
    }
}

function resolveRequestId(req) {
    const candidate = String(req.headers['x-request-id'] || '').trim();
    if (/^[a-zA-Z0-9._:-]{8,128}$/.test(candidate)) return candidate;
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return crypto.randomBytes(16).toString('hex');
}

function corsOrigin() {
    return process.env.CLOVER_SITE_API_ORIGIN || '*';
}

function safeJsonStringify(payload) {
    const seen = new WeakSet();
    return JSON.stringify(payload, (key, value) => {
        if (value instanceof Set) return [...value];
        if (value instanceof Map) return Object.fromEntries(value);
        if (value && typeof value === 'object') {
            if (seen.has(value)) return undefined;
            seen.add(value);
        }
        return value;
    });
}

function sendJson(res, status, payload) {
    const body = safeJsonStringify(payload);
    res.writeHead(status, {
        'Access-Control-Allow-Origin': corsOrigin(),
        'Access-Control-Allow-Headers': CORS_HEADERS,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS',
        'Access-Control-Expose-Headers': 'X-Request-Id',
        'Access-Control-Max-Age': '86400',
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function sendNoContent(res) {
    res.writeHead(204, {
        'Access-Control-Allow-Origin': corsOrigin(),
        'Access-Control-Allow-Headers': CORS_HEADERS,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS',
        'Access-Control-Expose-Headers': 'X-Request-Id',
        'Access-Control-Max-Age': '86400',
    });
    res.end();
}

function readJsonBody(req, limitBytes = 64 * 1024) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            raw += chunk;
            if (Buffer.byteLength(raw) > limitBytes) {
                reject(new HttpError(413, 'payload_too_large', 'JSON muito grande.'));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (!raw.trim()) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(new HttpError(400, 'invalid_json', 'JSON invalido.'));
            }
        });
        req.on('error', reject);
    });
}

function extractBearerToken(req) {
    const header = String(req.headers.authorization || '').trim();
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

async function requireAuth(db, req) {
    const token = extractBearerToken(req);
    const auth = await authenticateSiteSession(db, token);
    if (!auth.ok) {
        throw new HttpError(401, auth.reason || 'unauthorized', 'Sessao invalida ou expirada.');
    }
    return auth;
}

async function requireCanPlay(db, playerId) {
    const phase = await getPlayerPhase(db, playerId);
    if (!phase.canPlay) {
        throw new HttpError(403, 'game_blocked', 'Personagem ainda nao liberado para o jogo.', {
            phase: phase.phase,
        });
    }
    return phase;
}

async function withMutationQueue(action) {
    const context = requestContext.getStore() || {};
    const maxWaitMs = siteApiQueueWaitMs();
    try {
        return await runEconomyMutationExclusive(action, {
            maxWaitMs,
            operation: context.operation,
            requestId: context.requestId,
        });
    } catch (error) {
        if (!(error instanceof EconomyQueueTimeoutError)) throw error;
        throw new HttpError(
            503,
            'economy_queue_busy',
            'A economia esta processando outra operacao. Tente novamente em alguns segundos.',
            {
                requestId: context.requestId || null,
                operation: context.operation || null,
                waitMs: error.details?.waitMs || maxWaitMs,
            }
        );
    }
}

function publicPlayer(player = {}) {
    return {
        id: player.id,
        nome: player.nome,
        displayName: player.display_name,
        personagemNome: player.personagem_nome,
        reino: player.reino,
        raca: player.raca,
        classe: player.classe,
        familia: player.familia,
        grimorio: player.grimorio,
        magia: player.magia,
        fichaStatus: player.ficha_status,
        aparenciaStatus: player.personagem_aparencia_status,
        historiaStatus: player.historia_status,
        jogoStatus: player.jogo_status,
        numeroRollEscolhido: player.numero_roll_escolhido,
    };
}

function serializeTreeDefinition(tree) {
    if (!tree) return null;
    return {
        id: tree.id,
        name: tree.name,
        subtitle: tree.subtitle || null,
        aliases: tree.aliases || [],
        routes: tree.routes || [],
        nodes: tree.nodes || [],
        edges: tree.edges || [],
        goals: tree.goals || [],
    };
}

function serializeTreeState(state) {
    return {
        playerId: state.playerId,
        tree: serializeTreeDefinition(state.tree),
        ph: state.ph,
        discount: state.discount,
        ownedIds: state.ownedIds,
        totalNodes: state.totalNodes,
        ownedCount: state.ownedCount,
        routeProgress: state.routeProgress.map((item) => ({
            route: item.route,
            owned: item.owned,
            total: item.total,
            nodeIds: item.nodes.map((node) => node.id),
        })),
        nodeStates: state.nodeStates.map((item) => ({
            node: item.node,
            status: item.status,
            missingPh: item.missingPh,
            missingRequirements: item.missingRequirements || [],
            missingRequirementLabels: item.missingRequirementLabels || [],
            satisfiedRequirements: item.satisfiedRequirements || [],
            satisfiedRequirementLabels: item.satisfiedRequirementLabels || [],
            baseCost: item.baseCost,
            effectiveCost: item.effectiveCost,
            discount: item.discount,
        })),
        availableNodeIds: state.availableNodes.map((item) => item.node.id),
    };
}

function serializeAttributes(stats) {
    const values = getAttributeValues(stats, { usePending: stats.distribution_status === 'pending_confirmation' });
    const pb = getPbUsage(stats, { usePending: stats.distribution_status === 'pending_confirmation' });

    return {
        stats,
        values,
        valores: values,
        pb,
    };
}

function serializePhSummary(ph = {}) {
    return {
        ...ph,
        acumulado: Number(ph.phAccumulated || 0),
        disponivel: Number(ph.phAvailable || 0),
        estagio: ph.stageName || null,
        pb_total: Number(ph.pbTotal || 0),
        pb_usado: Number(ph.pbSpent || 0),
        pb_livre: Number(ph.pbFree || 0),
    };
}

function serializePhase(phase = {}) {
    const player = phase.player || {};
    return {
        fase: phase.phase,
        liberado: Boolean(phase.canPlay),
        ficha: player.ficha_status || null,
        aparencia: player.personagem_aparencia_status || null,
        historia: player.historia_status || null,
        jogo: player.jogo_status || null,
        rolls: Number(phase.rollCount || 0),
        perfil_pendente: Boolean(phase.pendingProfile),
        magia_pendente: Boolean(phase.pendingMagic),
    };
}

function serializeCavalier(cavalier = {}) {
    if (!cavalier?.ok) return null;
    return {
        yulls: Number(cavalier.yulls || 0),
        estrelas: Number(cavalier.stars || 0),
        patente: cavalier.patent || null,
        patente_recomendada: cavalier.recommendedPatent || null,
        esquadrao: cavalier.squad || null,
        inventario_total: Number(cavalier.inventoryCount || 0),
    };
}

function serializeTraits(player = {}) {
    return {
        aptidao: player.aptidao_rara && player.aptidao_rara !== '-'
            ? player.aptidao_rara
            : (player.aptidao_comum || null),
        aptidao_comum: player.aptidao_comum || null,
        aptidao_rara: player.aptidao_rara || null,
        marca: player.marca_rara && player.marca_rara !== '-'
            ? player.marca_rara
            : (player.marca_comum || null),
        marca_comum: player.marca_comum || null,
        marca_rara: player.marca_rara || null,
        anomalia: player.anomalia || null,
        gancho: player.gancho_narrativo || null,
    };
}

function serializeHexagon(hexagon = {}) {
    const controle = Number(hexagon.controle || 1);
    const precisao = Number(hexagon.precisao || 1);
    const estabilidade = Number(hexagon.estabilidade || 1);
    const retencao = Number(hexagon.retencao || 1);
    const alcance = Number(hexagon.alcance || 1);
    const escala = Number(hexagon.escala || 1);
    const limits = getHexagonDerivedLimits(hexagon);

    return {
        CON: controle,
        PRI: precisao,
        EST: estabilidade,
        RET: retencao,
        ALC: alcance,
        ESC: escala,
        controle,
        precisao,
        estabilidade,
        retencao,
        alcance,
        escala,
        limites: {
            controle: limits.controleLabel,
            precisao: limits.precisaoLabel,
            estabilidade: limits.estabilidadeLabel,
            duracao: limits.duracaoLabel,
            alcance: limits.alcanceLabel,
            escala: limits.escalaLabel,
        },
    };
}

function serializeCapacityForSite(capacity = {}) {
    if (!capacity?.ok) return null;

    const summary = buildProfileCapacitySummary(capacity);
    return {
        criacao: summary.creation,
        reforco: summary.reinforcement,
        fisico: summary.physical,
        mana: summary.mana,
        resumo: summary.summary,
        arvores: capacity.treeSummaries || {},
        proximos_nos: capacity.nextNodes || {},
        custos_comuns: capacity.commonCosts || {},
        bruto: capacity,
    };
}

function serializeReserveForSite(reserve = {}) {
    const percent = Number(reserve.percent || 0);
    const amount = Number(reserve.amount || 0);
    const hasHeartReserve = percent > 0;

    return {
        percent,
        porcentagem: percent,
        amount,
        valor: amount,
        label: reserve.label || (hasHeartReserve ? `${amount} (${percent}% Heart)` : '-'),
        hasHeartReserve,
        has_heart_reserve: hasHeartReserve,
        tem_reserva_heart: hasHeartReserve,
    };
}

function serializeTreeDiscountsForSite(treeDiscounts = {}) {
    const list = Object.values(treeDiscounts || {}).map((discount) => ({
        treeId: discount.treeId,
        tree_id: discount.treeId,
        arvore: discount.treeId,
        label: discount.label,
        nome: discount.label,
        percent: Number(discount.percent || 0),
        porcentagem: Number(discount.percent || 0),
        sources: discount.sources || [],
        fontes: discount.sources || [],
    }));

    const byTree = {};
    for (const discount of list) {
        if (discount.treeId) byTree[discount.treeId] = discount;
    }

    return {
        byTree,
        por_arvore: byTree,
        list,
        lista: list,
    };
}

function serializeBonusForSite(bonus = {}) {
    if (!bonus?.ok) {
        const reserve = serializeReserveForSite({});
        return {
            ok: false,
            error: bonus?.error || null,
            mana: null,
            reserve,
            reserva: reserve,
            reserva_heart: reserve,
            hasHeartReserve: false,
            tem_reserva_heart: false,
            automatic: [],
            automaticos: [],
            notAutomatic: [],
            nao_automaticos: [],
            customBonuses: [],
            custom_bonuses: [],
            bonus_personalizados: [],
            treeDiscounts: {},
            descontos_arvore: {},
            treeDiscountList: [],
            descontos_arvore_lista: [],
            warnings: [],
            avisos: [],
        };
    }

    const reserve = serializeReserveForSite(bonus.reserve);
    const discounts = serializeTreeDiscountsForSite(bonus.treeDiscounts);
    const automatic = bonus.automatic || [];
    const notAutomatic = bonus.notAutomatic || [];
    const warnings = bonus.warnings || [];
    const customBonuses = bonus.customBonuses || [];

    return {
        ok: true,
        identity: bonus.identity || null,
        identidade: bonus.identity || null,
        keys: bonus.keys || null,
        chaves: bonus.keys || null,
        mana: bonus.mana || null,
        reserve,
        reserva: reserve,
        reserva_heart: reserve,
        hasHeartReserve: reserve.hasHeartReserve,
        has_heart_reserve: reserve.has_heart_reserve,
        tem_reserva_heart: reserve.tem_reserva_heart,
        traits: bonus.traits || null,
        tracos: bonus.traits || null,
        family: bonus.family || null,
        familia: bonus.family || null,
        automatic,
        automaticos: automatic,
        bonus_automaticos: automatic,
        notAutomatic,
        not_automatic: notAutomatic,
        nao_automaticos: notAutomatic,
        bonus_nao_automaticos: notAutomatic,
        customBonuses,
        custom_bonuses: customBonuses,
        bonus_personalizados: customBonuses,
        treeDiscounts: discounts.byTree,
        treeDiscountList: discounts.list,
        descontos_arvore: discounts.byTree,
        descontos_arvore_lista: discounts.list,
        warnings,
        avisos: warnings,
    };
}

function serializePower({ ph, stats, capacity, bonus }) {
    const serializedPh = serializePhSummary(ph);
    const pb = getPbUsage(stats, { usePending: stats.distribution_status === 'pending_confirmation' });
    return {
        escala: serializedPh.stageName || serializedPh.estagio || null,
        base: Number(capacity?.manaTotal || bonus?.mana?.total || 0),
        mana_total: Number(capacity?.manaTotal || bonus?.mana?.total || 0),
        poder_magico: Number(capacity?.poderMagico || 0),
        pb_total: Number(pb.pbTotal || 0),
        pb_usado: Number(pb.used || 0),
        pb_livre: Number(pb.free || 0),
        ph_disponivel: serializedPh.disponivel,
        ph_acumulado: serializedPh.acumulado,
    };
}

function parseAttributeValues(payload = {}) {
    const source = payload.values && typeof payload.values === 'object' ? payload.values : payload;
    const result = {};
    for (const key of ['forca', 'velocidade', 'agilidade', 'resistencia', 'poder_magico']) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            const value = Number(source[key]);
            if (!Number.isInteger(value)) {
                throw new HttpError(400, 'invalid_attribute_value', `Valor invalido para ${key}.`);
            }
            result[key] = value;
        }
    }
    return result;
}

async function buildCharacterPayload(db, playerId) {
    const [phase, bonus, stats, ph, capacity, cavalier, inventoryItems] = await Promise.all([
        getPlayerPhase(db, playerId),
        getCharacterBonusSummary(db, playerId),
        getCharacterStats(db, playerId),
        getPhSummary(db, playerId),
        getPlayerTechnicalCapacity(db, playerId),
        getCavalierSummary(db, playerId),
        getInventoryItems(db, playerId, 30),
    ]);
    const player = phase.player || bonus.player || cavalier.player || {};
    const publicCharacter = publicPlayer(player);
    const estado = serializePhase(phase);
    const cavaleiro = serializeCavalier(cavalier);
    const tracos = serializeTraits(player);
    const serializedPh = serializePhSummary(ph);
    const capacidade = serializeCapacityForSite(capacity);
    const hexagono = capacity?.ok ? serializeHexagon(capacity.hexagon) : serializeHexagon({});
    const poder = serializePower({ ph, stats, capacity, bonus });
    const bonusData = serializeBonusForSite(bonus);

    return {
        nome: player.personagem_nome || player.nome || player.display_name || null,
        reino: player.reino || null,
        raca: player.raca || null,
        classe: player.classe || null,
        familia: player.familia || null,
        grimorio: player.grimorio || null,
        magia: player.magia || null,
        player: publicCharacter,
        personagem: publicCharacter,
        phase: {
            phase: phase.phase,
            canPlay: phase.canPlay,
            rollCount: phase.rollCount,
            pendingProfile: phase.pendingProfile,
            pendingMagic: phase.pendingMagic,
        },
        estado,
        bonus: bonusData,
        bonus_ficha: bonusData,
        identity: bonusData.identity,
        keys: bonusData.keys,
        mana: bonusData.mana,
        reserve: bonusData.reserve,
        reserva: bonusData.reserve,
        reserva_heart: bonusData.reserve,
        hasHeartReserve: bonusData.hasHeartReserve,
        tem_reserva_heart: bonusData.tem_reserva_heart,
        traits: bonusData.traits,
        tracos,
        tracos_bonus: bonusData.traits,
        family: bonusData.family,
        automatic: bonusData.automatic,
        automaticos: bonusData.automaticos,
        notAutomatic: bonusData.notAutomatic,
        nao_automaticos: bonusData.nao_automaticos,
        treeDiscounts: bonusData.treeDiscounts,
        treeDiscountList: bonusData.treeDiscountList,
        descontos_arvore: bonusData.descontos_arvore,
        descontos_arvore_lista: bonusData.descontos_arvore_lista,
        warnings: bonusData.warnings,
        avisos: bonusData.avisos,
        attributes: serializeAttributes(stats),
        atributos: serializeAttributes(stats),
        ph: serializedPh,
        poder,
        capacity,
        capacidade,
        hexagono,
        alcance: hexagono.limites.alcance,
        duracao: hexagono.limites.duracao,
        impacto_mana: hexagono.limites.impacto_mana,
        wallet: cavalier.ok ? {
            yulls: cavalier.yulls,
            stars: cavalier.stars,
            patent: cavalier.patent,
            recommendedPatent: cavalier.recommendedPatent,
            squad: cavalier.squad,
            inventoryCount: cavalier.inventoryCount,
        } : null,
        cavaleiro,
        inventory: inventoryItems,
        inventario: inventoryItems,
    };
}

async function routePublic(req, res, db, method, parts, pathname) {
    const matchedRoute = matchDescriptor(SITE_API_BASE_PUBLIC_ROUTE_DESCRIPTORS, method, pathname);
    if (!matchedRoute && !SITE_API_BASE_PUBLIC_ROUTE_DESCRIPTORS.some((route) => route.match(pathname))) return false;
    if (method === 'GET' && parts.length === 0) {
        sendJson(res, 200, {
            ok: true,
            name: 'Clover Multicolor Site API',
            endpoints: [
                'POST /auth/login',
                'POST /auth/logout',
                'GET /me',
                'GET /access',
                'GET /squads/:key/members',
                'GET /squads/:key/upgrades',
                'GET /character',
                'GET /character/appearance',
                'PUT /character/profile-image',
                'GET /character/spellbook',
                'GET /status',
                'GET /bonus',
                'GET /capabilities',
                'GET /hexagono',
                'POST /hexagono',
                'GET /attributes',
                'PUT /attributes',
                'GET /inventory',
                'GET /economy',
                'GET /shops',
                'GET /shops/:key',
                'GET /economy/salary',
                'POST /economy/initial-package',
                'POST /economy/purchases/preview',
                'POST /economy/purchases/:key/confirm',
                'POST /economy/purchases/:key/cancel',
                'POST /economy/sales/preview',
                'POST /economy/sales/:key/confirm',
                'POST /economy/repairs/preview',
                'POST /economy/repairs/:key/confirm',
                'POST /economy/consumables/:itemId/use',
                'GET /economy/market/dashboard',
                'GET /economy/market',
                'POST /economy/payments/preview',
                'POST /economy/payments/:key/confirm',
                'POST /economy/payments/:key/cancel',
                'POST /economy/market/listings',
                'POST /economy/market/listings/:key/cancel',
                'POST /economy/market/purchases/preview',
                'POST /economy/market/purchases/:key/confirm',
                'POST /economy/market/purchases/:key/cancel',
                'POST /economy/market/auctions/:key/bids',
                'GET /economy/trades',
                'POST /economy/trades',
                'PATCH /economy/trades/:key',
                'POST /economy/trades/:key/confirm',
                'POST /economy/trades/:key/cancel',
                'GET /economy/weekly-requests',
                'POST /economy/weekly-requests/:key/deliver',
                'POST /economy/weekly-requests',
                'PATCH /economy/weekly-requests/:key',
                'POST /economy/weekly-requests/:key/cancel',
                'GET /economy/item-templates',
                'POST /economy/item-templates',
                'PATCH /economy/item-templates/:key',
                'POST /economy/item-templates/:key/archive',
                'POST /economy/item-templates/:key/grant',
                'GET /economy/redemptions',
                'POST /economy/redemptions',
                'GET /economy/redemptions/pending',
                'POST /economy/redemptions/:key/cancel',
                'POST /economy/redemptions/:key/approve',
                'POST /economy/redemptions/:key/reject',
                'GET /economy/titles',
                'POST /economy/titles/:key/activate',
                'POST /economy/titles/deactivate',
                'GET /boxes',
                'POST /boxes/:key/open',
                'GET /raids',
                'POST /raids',
                'GET /raids/:key',
                'POST /raids/:key/join',
                'PUT /raids/:key/loadout/:slot',
                'POST /raids/:key/start',
                'POST /raids/:key/finalize',
                'POST /raids/:key/conditions',
                'POST /raids/:key/complete',
                'GET /ph',
                'GET /yulls',
                'GET /pr',
                'GET /recruitment',
                'POST /recruitment/referrer',
                'GET /recruitment/shop',
                'GET /trees',
                'GET /trees/:treeId',
                'POST /trees/:treeId/purchase',
            ],
        });
        return true;
    }

    if (method === 'GET' && parts[0] === 'health') {
        sendJson(res, 200, {
            ok: true,
            status: 'online',
            queue: getEconomyQueueState(),
        });
        return true;
    }

    if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'login') {
        const body = await readJsonBody(req);
        const result = await loginWithSiteCode(db, body);
        if (!result.ok) {
            throw new HttpError(401, result.reason || 'invalid_credentials', 'Numero ou codigo invalido.');
        }

        sendJson(res, 200, {
            ok: true,
            token: result.token,
            expiresAt: result.expiresAt,
            player: publicPlayer(result.player),
        });
        return true;
    }

    return false;
}

async function routeAuthed(req, res, db, method, parts, auth, pathname) {
    const matchedRoute = matchDescriptor(SITE_API_BASE_AUTHED_ROUTE_DESCRIPTORS, method, pathname);
    if (!matchedRoute && !SITE_API_BASE_AUTHED_ROUTE_DESCRIPTORS.some((route) => route.match(pathname))) return false;
    const playerId = auth.player.id;

    if (method === 'POST' && parts[0] === 'auth' && parts[1] === 'logout') {
        await revokeSiteSession(db, extractBearerToken(req));
        sendJson(res, 200, { ok: true });
        return true;
    }

    if (method === 'GET' && (parts[0] === 'access' || parts[0] === 'context')) {
        sendJson(res, 200, {
            ok: true,
            access: await buildSiteAccessPayload(db, playerId),
        });
        return true;
    }

    if (method === 'GET' && parts[0] === 'squads' && parts[1] && parts[2] === 'members') {
        const directory = await getSquadMemberDirectory(db, {
            actorId: playerId,
            squadInput: decodeURIComponent(parts[1]),
        });
        if (!directory.ok) {
            const status = directory.code === 'squad_not_found' ? 404 : 403;
            throw new HttpError(
                status,
                directory.code,
                status === 404 ? 'Esquadrao nao encontrado.' : 'Seu cargo nao permite consultar esses membros.'
            );
        }
        sendJson(res, 200, { ok: true, directory });
        return true;
    }

    if (method === 'GET' && parts[0] === 'squads' && parts[1] && parts[2] === 'upgrades') {
        const catalog = await getSiteSquadUpgradeCatalog(db, {
            actorId: playerId,
            squadInput: decodeURIComponent(parts[1]),
        });
        if (!catalog.ok) {
            const status = catalog.code === 'squad_not_found' ? 404 : 403;
            throw new HttpError(
                status,
                catalog.code,
                status === 404 ? 'Esquadrao nao encontrado.' : 'Sua sessao nao pode consultar este QG.'
            );
        }
        sendJson(res, 200, { ok: true, catalog });
        return true;
    }

    if (method === 'GET' && parts[0] === 'me') {
        const phase = await getPlayerPhase(db, playerId);
        sendJson(res, 200, {
            ok: true,
            player: publicPlayer(phase.player || auth.player),
            estado: serializePhase(phase),
            phase: {
                phase: phase.phase,
                canPlay: phase.canPlay,
                rollCount: phase.rollCount,
                pendingProfile: phase.pendingProfile,
                pendingMagic: phase.pendingMagic,
            },
        });
        return true;
    }

    if (method === 'GET' && (parts[0] === 'bonus' || parts[0] === 'bonuses')) {
        const bonus = serializeBonusForSite(await getCharacterBonusSummary(db, playerId));
        sendJson(res, 200, {
            ok: true,
            data: bonus,
            bonus,
            mana: bonus.mana,
            reserve: bonus.reserve,
            reserva: bonus.reserve,
            reserva_heart: bonus.reserve,
            hasHeartReserve: bonus.hasHeartReserve,
            tem_reserva_heart: bonus.tem_reserva_heart,
            automatic: bonus.automatic,
            automaticos: bonus.automaticos,
            notAutomatic: bonus.notAutomatic,
            nao_automaticos: bonus.nao_automaticos,
            treeDiscounts: bonus.treeDiscounts,
            descontos_arvore: bonus.descontos_arvore,
            treeDiscountList: bonus.treeDiscountList,
            descontos_arvore_lista: bonus.descontos_arvore_lista,
        });
        return true;
    }

    if (method === 'GET' && parts[0] === 'status') {
        const phase = await getPlayerPhase(db, playerId);
        sendJson(res, 200, {
            ok: true,
            player: publicPlayer(phase.player || auth.player),
            estado: serializePhase(phase),
            phase: {
                phase: phase.phase,
                canPlay: phase.canPlay,
                rollCount: phase.rollCount,
                pendingProfile: phase.pendingProfile,
                pendingMagic: phase.pendingMagic,
            },
        });
        return true;
    }

    if (method === 'GET' && parts[0] === 'character' && parts[1] === 'appearance') {
        const phase = await getPlayerPhase(db, playerId);
        const player = phase.player || auth.player || {};
        sendJson(res, 200, {
            ok: true,
            appearance: {
                status: player.personagem_aparencia_status || null,
                text: player.personagem_aparencia || null,
                imagePath: player.personagem_aparencia_image_path || null,
                profileImage: player.site_profile_image_data || null,
                profileImageUpdatedAt: player.site_profile_image_updated_at || null,
                updatedAt: player.personagem_aparencia_updated_at || null,
                approvedAt: player.personagem_aparencia_approved_at || null,
                reason: player.personagem_aparencia_motivo || null,
            },
            aparencia: {
                status: player.personagem_aparencia_status || null,
                texto: player.personagem_aparencia || null,
                imagem: player.personagem_aparencia_image_path || null,
                imagem_perfil: player.site_profile_image_data || null,
                imagem_perfil_atualizada_em: player.site_profile_image_updated_at || null,
                atualizada_em: player.personagem_aparencia_updated_at || null,
                aprovada_em: player.personagem_aparencia_approved_at || null,
                motivo: player.personagem_aparencia_motivo || null,
            },
        });
        return true;
    }

    if (method === 'PUT' && parts[0] === 'character' && parts[1] === 'profile-image') {
        const body = await readJsonBody(req, 280 * 1024);
        try {
            const result = await withMutationQueue(() => saveProfileImage(
                db,
                playerId,
                body.image ?? body.imagem ?? null
            ));
            sendJson(res, 200, {
                ok: true,
                profileImage: result.image,
                imagemPerfil: result.image,
                updatedAt: result.updatedAt,
            });
        } catch (error) {
            if (!(error instanceof ProfileImageServiceError)) throw error;
            const status = error.code === 'player_not_found' ? 404 : error.code === 'profile_image_too_large' ? 413 : 400;
            throw new HttpError(status, error.code, error.message, error.details || null);
        }
        return true;
    }

    if (method === 'GET' && parts[0] === 'character' && parts[1] === 'spellbook') {
        const spellbook = await getSiteSpellbook(db, playerId);
        sendJson(res, 200, {
            ok: true,
            spellbook,
            grimorio: spellbook,
        });
        return true;
    }

    if (method === 'GET' && parts[0] === 'character' && parts.length === 1) {
        sendJson(res, 200, { ok: true, data: await buildCharacterPayload(db, playerId) });
        return true;
    }

    if (method === 'GET' && (parts[0] === 'capabilities' || parts[0] === 'capacidades')) {
        const capacity = await getPlayerTechnicalCapacity(db, playerId);
        sendJson(res, 200, {
            ok: true,
            capacity,
            capacidade: serializeCapacityForSite(capacity),
        });
        return true;
    }

    if (method === 'GET' && (parts[0] === 'hexagono' || parts[0] === 'hexagon')) {
        const hexagon = await getOrCreateHexagon(db, playerId);
        const serialized = serializeHexagon(hexagon);
        sendJson(res, 200, {
            ok: true,
            hexagon,
            hexagono: serialized,
            limits: serialized.limites,
            limites: serialized.limites,
            alcance: serialized.limites.alcance,
            duracao: serialized.limites.duracao,
            impacto_mana: serialized.limites.impacto_mana,
        });
        return true;
    }

    if (method === 'POST' && (parts[0] === 'hexagono' || parts[0] === 'hexagon')) {
        await requireCanPlay(db, playerId);
        const body = await readJsonBody(req);
        const side = String(body.side || body.lado || body.key || body.nome || '').trim();
        if (!side) {
            throw new HttpError(400, 'missing_side', 'Informe side/lado do Hexagono.');
        }

        const requestResult = await createPendingHexagonUpgrade(db, playerId, side, playerId);
        if (!requestResult.ok) {
            throw new HttpError(400, requestResult.reason || 'hexagon_upgrade_failed', 'Up de Hexagono nao solicitado.', requestResult);
        }

        let applied = null;
        if (!requestResult.pending?.requiresApproval && body.confirm !== false) {
            applied = await confirmPendingHexagonUpgrade(db, playerId, playerId);
            if (!applied.ok) {
                throw new HttpError(400, applied.reason || 'hexagon_confirm_failed', 'Up de Hexagono nao confirmado.', applied);
            }
        }

        const hexagon = await getOrCreateHexagon(db, playerId);
        const serialized = serializeHexagon(hexagon);
        sendJson(res, 200, {
            ok: true,
            pending: requestResult.pending,
            applied,
            requiresApproval: Boolean(requestResult.pending?.requiresApproval),
            hexagon,
            hexagono: serialized,
            limits: serialized.limites,
            limites: serialized.limites,
        });
        return true;
    }

    if (parts[0] === 'economy' || parts[0] === 'shops') {
        await requireCanPlay(db, playerId);
        try {
            if (method === 'GET' && parts[0] === 'economy' && parts.length === 1) {
                const dashboard = await withMutationQueue(() => getEconomyDashboard(db, playerId));
                sendJson(res, 200, { ok: true, economy: dashboard, economia: dashboard });
                return true;
            }

            if (method === 'GET' && parts[0] === 'shops' && parts.length === 1) {
                const shops = await withMutationQueue(() => listShops(db));
                sendJson(res, 200, { ok: true, shops, lojas: shops });
                return true;
            }

            if (method === 'GET' && parts[0] === 'shops' && parts[1]) {
                const catalog = await withMutationQueue(() => getShopCatalog(db, parts[1]));
                sendJson(res, 200, { ok: true, catalog, loja: catalog });
                return true;
            }

            if (method === 'GET' && parts[0] === 'economy' && parts[1] === 'salary') {
                const salary = await withMutationQueue(() => getSalaryDashboard(db, playerId));
                sendJson(res, 200, { ok: true, salary, salario: salary });
                return true;
            }

            if (method === 'GET' && parts[0] === 'economy' && parts[1] === 'market' && parts[2] === 'dashboard') {
                const dashboard = await withMutationQueue(() => getMarketDashboard(db, playerId));
                sendJson(res, 200, { ok: true, dashboard, mercado: dashboard });
                return true;
            }

            if (method === 'GET' && parts[0] === 'economy' && parts[1] === 'market' && parts.length === 2) {
                const url = new URL(req.url, 'http://localhost');
                const listings = await withMutationQueue(() => listMarket(db, playerId, {
                    type: url.searchParams.get('type') || url.searchParams.get('tipo') || null,
                    mine: ['1', 'true', 'sim'].includes(String(url.searchParams.get('mine') || url.searchParams.get('meus') || '').toLowerCase()),
                    limit: Number(url.searchParams.get('limit') || 50),
                }));
                sendJson(res, 200, { ok: true, listings, anuncios: listings });
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'payments' && parts[2] === 'preview') {
                const body = await readJsonBody(req);
                const idempotencyKey = requestIdempotencyKey(req, body);
                if (!idempotencyKey) throw new HttpError(400, 'missing_idempotency_key', 'Envie Idempotency-Key para simular o pagamento.');
                const result = await withMutationQueue(() => previewPayment(
                    db,
                    playerId,
                    body.recipientId || body.recipient_id || body.destinatario,
                    body.amount || body.valor,
                    body.reason || body.motivo,
                    { idempotencyKey, via: 'site' }
                ));
                sendJson(res, 201, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'payments' && parts[2] && parts[3] === 'confirm') {
                const result = await withMutationQueue(() => confirmPayment(db, playerId, parts[2]));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'payments' && parts[2] && parts[3] === 'cancel') {
                const result = await withMutationQueue(() => cancelPayment(db, playerId, parts[2]));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'market' && parts[2] === 'listings' && parts.length === 3) {
                const body = await readJsonBody(req);
                const idempotencyKey = requestIdempotencyKey(req, body);
                if (!idempotencyKey) throw new HttpError(400, 'missing_idempotency_key', 'Envie Idempotency-Key para publicar o anúncio.');
                const fixedListing = { ...body, type: 'fixed', tipo: 'fixo', durationHours: 168 };
                const result = await withMutationQueue(() => createMarketListing(db, playerId, fixedListing, { via: 'site', idempotencyKey }));
                sendJson(res, result.duplicate ? 200 : 201, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'market' && parts[2] === 'listings' && parts[3] === 'preview') {
                const body = await readJsonBody(req);
                const fixedListing = { ...body, type: 'fixed', tipo: 'fixo', durationHours: 168 };
                const result = await withMutationQueue(() => quoteMarketListing(db, playerId, fixedListing));
                sendJson(res, 200, { ok: true, quote: result, cotacao: result });
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'market' && parts[2] === 'listings' && parts[3] && parts[4] === 'cancel') {
                const result = await withMutationQueue(() => cancelMarketListing(db, playerId, parts[3]));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'market' && parts[2] === 'purchases' && parts[3] === 'preview') {
                const body = await readJsonBody(req);
                const idempotencyKey = requestIdempotencyKey(req, body);
                if (!idempotencyKey) throw new HttpError(400, 'missing_idempotency_key', 'Envie Idempotency-Key para simular a compra.');
                const result = await withMutationQueue(() => previewMarketPurchase(
                    db,
                    playerId,
                    body.listingKey || body.listing_key || body.anuncio,
                    body.quantity || body.quantidade || 1,
                    { idempotencyKey, via: 'site' }
                ));
                sendJson(res, 201, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'market' && parts[2] === 'purchases' && parts[3] && parts[4] === 'confirm') {
                const result = await withMutationQueue(() => confirmMarketPurchase(db, playerId, parts[3]));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'market' && parts[2] === 'purchases' && parts[3] && parts[4] === 'cancel') {
                const result = await withMutationQueue(() => cancelMarketPurchase(db, playerId, parts[3]));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'market' && parts[2] === 'auctions' && parts[3] && parts[4] === 'bids') {
                const body = await readJsonBody(req);
                const idempotencyKey = requestIdempotencyKey(req, body);
                if (!idempotencyKey) throw new HttpError(400, 'missing_idempotency_key', 'Envie Idempotency-Key para dar o lance.');
                const result = await withMutationQueue(() => placeAuctionBid(
                    db, playerId, parts[3], body.amount || body.valor || body.lance,
                    { idempotencyKey, via: 'site' }
                ));
                sendJson(res, 201, result);
                return true;
            }

            if (method === 'GET' && parts[0] === 'economy' && parts[1] === 'trades' && parts.length === 2) {
                const trades = await listTrades(db, playerId, 50);
                sendJson(res, 200, { ok: true, trades, trocas: trades });
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'trades' && parts.length === 2) {
                const body = await readJsonBody(req);
                const result = await withMutationQueue(() => createSecureTrade(
                    db,
                    playerId,
                    body.targetId || body.target_id || body.destinatario,
                    body,
                    { via: 'site' }
                ));
                sendJson(res, 201, result);
                return true;
            }

            if (method === 'PATCH' && parts[0] === 'economy' && parts[1] === 'trades' && parts[2] && parts.length === 3) {
                const body = await readJsonBody(req);
                const result = await withMutationQueue(() => updateTradeSide(db, playerId, parts[2], body));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'trades' && parts[2] && parts[3] === 'confirm') {
                const result = await withMutationQueue(() => confirmSecureTrade(db, playerId, parts[2]));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'trades' && parts[2] && parts[3] === 'cancel') {
                const result = await withMutationQueue(() => cancelSecureTrade(db, playerId, parts[2]));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'GET' && parts[0] === 'economy' && parts[1] === 'weekly-requests') {
                const requests = await withMutationQueue(() => listWeeklyNpcRequests(db, playerId));
                sendJson(res, 200, { ok: true, requests, pedidos: requests });
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'weekly-requests' && parts.length === 2) {
                const body = await readJsonBody(req);
                const result = await withMutationQueue(() => createWeeklyNpcRequest(db, playerId, body, { via: 'api' }));
                sendJson(res, 201, result);
                return true;
            }

            if (method === 'PATCH' && parts[0] === 'economy' && parts[1] === 'weekly-requests' && parts[2] && parts.length === 3) {
                const body = await readJsonBody(req);
                const result = await withMutationQueue(() => updateWeeklyNpcRequest(db, playerId, parts[2], body));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'weekly-requests' && parts[2] && parts[3] === 'cancel') {
                const result = await withMutationQueue(() => cancelWeeklyNpcRequest(db, playerId, parts[2]));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'weekly-requests' && parts[2] && parts[3] === 'deliver') {
                const body = await readJsonBody(req);
                const idempotencyKey = requestIdempotencyKey(req, body);
                if (!idempotencyKey) throw new HttpError(400, 'missing_idempotency_key', 'Envie Idempotency-Key para entregar o item.');
                const result = await withMutationQueue(() => fulfillWeeklyNpcRequest(
                    db,
                    playerId,
                    parts[2],
                    body.inventoryItemId || body.inventory_item_id || body.itemId,
                    body.quantity || body.quantidade || 1,
                    { idempotencyKey, via: 'site' }
                ));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'GET' && parts[0] === 'economy' && parts[1] === 'item-templates') {
                const url = new URL(req.url, 'http://localhost');
                const templates = await listItemTemplates(db, {
                    customOnly: ['1', 'true', 'sim'].includes(String(url.searchParams.get('custom') || '').toLowerCase()),
                    includeArchived: ['1', 'true', 'sim'].includes(String(url.searchParams.get('archived') || '').toLowerCase()),
                    limit: Number(url.searchParams.get('limit') || 100),
                });
                sendJson(res, 200, { ok: true, templates, modelos: templates });
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'item-templates' && parts.length === 2) {
                const body = await readJsonBody(req);
                const result = await withMutationQueue(() => createItemTemplate(db, playerId, body));
                sendJson(res, 201, result);
                return true;
            }

            if (method === 'PATCH' && parts[0] === 'economy' && parts[1] === 'item-templates' && parts[2] && parts.length === 3) {
                const body = await readJsonBody(req);
                const result = await withMutationQueue(() => updateItemTemplate(db, playerId, parts[2], body));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'item-templates' && parts[2] && parts[3] === 'archive') {
                const result = await withMutationQueue(() => archiveItemTemplate(db, playerId, parts[2]));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'item-templates' && parts[2] && parts[3] === 'grant') {
                const body = await readJsonBody(req);
                const idempotencyKey = requestIdempotencyKey(req, body);
                if (!idempotencyKey) throw new HttpError(400, 'missing_idempotency_key', 'Envie Idempotency-Key para gerar as cópias.');
                const result = await withMutationQueue(() => grantItemCopies(
                    db,
                    playerId,
                    body.playerId || body.player_id || body.jogador,
                    parts[2],
                    body.quantity || body.quantidade || 1,
                    { idempotencyKey, source: 'item_admin_api', relatedId: idempotencyKey, forceSeparate: Boolean(body.forceSeparate || body.separado) }
                ));
                sendJson(res, result.duplicate ? 200 : 201, result);
                return true;
            }

            if (method === 'GET' && parts[0] === 'economy' && parts[1] === 'redemptions' && parts.length === 2) {
                const redemptions = await listOwnItemRedemptions(db, playerId);
                sendJson(res, 200, { ok: true, redemptions, resgates: redemptions });
                return true;
            }

            if (method === 'GET' && parts[0] === 'economy' && parts[1] === 'redemptions' && parts[2] === 'pending') {
                const redemptions = await listPendingItemRedemptions(db, playerId);
                sendJson(res, 200, { ok: true, redemptions, resgates: redemptions });
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'redemptions' && parts.length === 2) {
                const body = await readJsonBody(req);
                const idempotencyKey = requestIdempotencyKey(req, body);
                if (!idempotencyKey) throw new HttpError(400, 'missing_idempotency_key', 'Envie Idempotency-Key para solicitar o resgate.');
                const result = await withMutationQueue(() => requestItemRedemption(
                    db, playerId, body.inventoryItemId || body.inventory_item_id || body.itemId,
                    body.note || body.observacao || null,
                    { idempotencyKey, metadata: { via: 'site' } }
                ));
                sendJson(res, result.duplicate ? 200 : 201, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'redemptions' && parts[2] && parts[3] === 'cancel') {
                const result = await withMutationQueue(() => cancelItemRedemption(db, playerId, parts[2]));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'redemptions' && parts[2] && ['approve', 'reject'].includes(parts[3])) {
                const body = await readJsonBody(req);
                const result = await withMutationQueue(() => resolveItemRedemption(
                    db, playerId, parts[2], parts[3] === 'approve' ? 'approved' : 'rejected', body.note || body.observacao || null
                ));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'GET' && parts[0] === 'economy' && parts[1] === 'titles') {
                const titles = await listPlayerTitles(db, playerId);
                sendJson(res, 200, { ok: true, titles, titulos: titles });
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'titles' && parts[2] === 'deactivate' && parts.length === 3) {
                const result = await withMutationQueue(() => deactivatePlayerTitle(db, playerId));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'titles' && parts[2] && parts[3] === 'activate') {
                const result = await withMutationQueue(() => activatePlayerTitle(db, playerId, parts[2]));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'initial-package') {
                const body = await readJsonBody(req);
                const equipmentTemplateKey = String(
                    body.equipmentTemplateKey || body.equipment_template_key || body.equipamento || ''
                ).trim();
                if (!equipmentTemplateKey) {
                    throw new HttpError(400, 'missing_initial_equipment', 'Informe o equipamento inicial.');
                }
                const result = await withMutationQueue(() => grantInitialPackage(db, playerId, equipmentTemplateKey, {
                    actorId: playerId,
                    via: 'site',
                }));
                sendJson(res, result.duplicate ? 200 : 201, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'purchases' && parts[2] === 'preview') {
                const body = await readJsonBody(req);
                const idempotencyKey = requestIdempotencyKey(req, body);
                if (!idempotencyKey) throw new HttpError(400, 'missing_idempotency_key', 'Envie Idempotency-Key para simular a compra.');
                const result = await withMutationQueue(() => previewPurchase(
                    db,
                    playerId,
                    body.listingKey || body.listing_key || body.codigo,
                    body.quantity || body.quantidade || 1,
                    {
                        express: Boolean(body.express || body.expresso),
                        useVoucher: Boolean(body.useVoucher || body.usar_vale),
                        idempotencyKey,
                        via: 'site',
                    }
                ));
                sendJson(res, 201, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'purchases' && parts[2] && parts[3] === 'confirm') {
                const result = await withMutationQueue(() => confirmPurchase(db, playerId, parts[2], { via: 'site' }));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'purchases' && parts[2] && parts[3] === 'cancel') {
                const result = await withMutationQueue(() => cancelPurchase(db, playerId, parts[2], { via: 'site' }));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'sales' && parts[2] === 'preview') {
                const body = await readJsonBody(req);
                const idempotencyKey = requestIdempotencyKey(req, body);
                if (!idempotencyKey) throw new HttpError(400, 'missing_idempotency_key', 'Envie Idempotency-Key para simular a venda.');
                const result = await withMutationQueue(() => previewNpcSale(
                    db,
                    playerId,
                    body.inventoryItemId || body.inventory_item_id || body.itemId,
                    body.quantity || body.quantidade || 1,
                    { idempotencyKey, via: 'site' }
                ));
                sendJson(res, 201, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'sales' && parts[2] && parts[3] === 'confirm') {
                const result = await withMutationQueue(() => confirmNpcSale(db, playerId, parts[2]));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'repairs' && parts[2] === 'preview') {
                const body = await readJsonBody(req);
                const idempotencyKey = requestIdempotencyKey(req, body);
                if (!idempotencyKey) throw new HttpError(400, 'missing_idempotency_key', 'Envie Idempotency-Key para simular o reparo.');
                const result = await withMutationQueue(() => previewRepair(
                    db,
                    playerId,
                    body.inventoryItemId || body.inventory_item_id || body.itemId,
                    {
                        express: Boolean(body.express || body.expresso),
                        useVoucher: Boolean(body.useVoucher || body.usar_vale),
                        idempotencyKey,
                        via: 'site',
                    }
                ));
                sendJson(res, 201, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'repairs' && parts[2] && parts[3] === 'confirm') {
                const result = await withMutationQueue(() => confirmRepair(db, playerId, parts[2], { via: 'site' }));
                sendJson(res, 200, result);
                return true;
            }

            if (method === 'POST' && parts[0] === 'economy' && parts[1] === 'consumables' && parts[2] && parts[3] === 'use') {
                const body = await readJsonBody(req);
                const idempotencyKey = requestIdempotencyKey(req, body);
                if (!idempotencyKey) throw new HttpError(400, 'missing_idempotency_key', 'Envie Idempotency-Key para usar o item.');
                const result = await withMutationQueue(() => useConsumable(db, playerId, Number(parts[2]), {
                    contextType: body.contextType || body.context_type || 'livre',
                    contextId: body.contextId || body.context_id || null,
                    idempotencyKey,
                    via: 'site',
                }));
                sendJson(res, 200, result);
                return true;
            }
        } catch (error) {
            throw economyHttpError(marketHttpError(error));
        }
    }

    if (parts[0] === 'raids') {
        try {
            if (method === 'GET' && parts.length === 1) {
                const limit = Number(new URL(req.url, 'http://localhost').searchParams.get('limit') || 30);
                const raids = await listActorRaids(db, playerId, { limit });
                sendJson(res, 200, { ok: true, raids, missoes: raids });
                return true;
            }

            if (method === 'POST' && parts.length === 1) {
                const body = await readJsonBody(req);
                const result = await withMutationQueue(() => createRaid(db, playerId, body));
                sendJson(res, 201, result);
                return true;
            }

            const raidKey = parts[1];
            if (raidKey && method === 'GET' && parts.length === 2) {
                const dashboard = await getRaidDashboard(db, raidKey, playerId);
                sendJson(res, 200, { ok: true, dashboard, raid: dashboard });
                return true;
            }

            if (raidKey && method === 'POST' && parts[2] === 'join') {
                await requireCanPlay(db, playerId);
                const result = await withMutationQueue(() => joinRaid(db, raidKey, playerId, { via: 'site' }));
                sendJson(res, 200, result);
                return true;
            }

            if (raidKey && method === 'POST' && parts[2] === 'leave') {
                const result = await withMutationQueue(() => leaveRaid(db, raidKey, playerId));
                sendJson(res, 200, result);
                return true;
            }

            if (raidKey && method === 'POST' && parts[2] === 'hosts' && parts.length === 3) {
                const body = await readJsonBody(req);
                const targetPlayerId = body.playerId || body.player_id;
                if (!targetPlayerId) throw new HttpError(400, 'missing_player_id', 'Informe playerId do co-host.');
                const result = await withMutationQueue(() => addRaidHost(db, raidKey, playerId, targetPlayerId));
                sendJson(res, 200, result);
                return true;
            }

            if (raidKey && method === 'POST' && parts[2] === 'hosts' && parts[3] === 'revoke') {
                const body = await readJsonBody(req);
                const targetPlayerId = body.playerId || body.player_id;
                if (!targetPlayerId) throw new HttpError(400, 'missing_player_id', 'Informe playerId do co-host.');
                const result = await withMutationQueue(() => revokeRaidHost(db, raidKey, playerId, targetPlayerId));
                sendJson(res, 200, result);
                return true;
            }

            if (raidKey && method === 'POST' && parts[2] === 'participants' && parts[3] === 'remove') {
                const body = await readJsonBody(req);
                const targetPlayerId = body.playerId || body.player_id;
                if (!targetPlayerId) throw new HttpError(400, 'missing_player_id', 'Informe playerId do participante.');
                const result = await withMutationQueue(() => removeRaidParticipant(
                    db,
                    raidKey,
                    playerId,
                    targetPlayerId,
                    body.reason || body.motivo || null
                ));
                sendJson(res, 200, result);
                return true;
            }

            if (raidKey && method === 'GET' && parts[2] === 'participants' && parts[3]) {
                const detail = await getRaidParticipantDetail(db, raidKey, playerId, parts[3]);
                sendJson(res, 200, { ok: true, detail, participante: detail });
                return true;
            }

            if (raidKey && method === 'PUT' && parts[2] === 'loadout' && parts[3]) {
                const body = await readJsonBody(req);
                const result = await withMutationQueue(() => setRaidLoadoutSlot(
                    db,
                    raidKey,
                    playerId,
                    parts[3],
                    body
                ));
                sendJson(res, 200, result);
                return true;
            }

            if (raidKey && method === 'POST' && parts[2] === 'start') {
                const result = await withMutationQueue(() => startRaid(db, raidKey, playerId));
                sendJson(res, 200, result);
                return true;
            }

            if (raidKey && method === 'POST' && parts[2] === 'finalize') {
                const result = await withMutationQueue(() => beginRaidFinalization(db, raidKey, playerId));
                sendJson(res, 200, result);
                return true;
            }

            if (raidKey && method === 'POST' && parts[2] === 'cancel') {
                const body = await readJsonBody(req);
                const result = await withMutationQueue(() => cancelRaid(
                    db,
                    raidKey,
                    playerId,
                    body.reason || body.motivo || null
                ));
                sendJson(res, 200, result);
                return true;
            }

            if (raidKey && method === 'POST' && parts[2] === 'items' && parts[3] && parts[4] === 'wear') {
                const body = await readJsonBody(req);
                const idempotencyKey = requestIdempotencyKey(req, body);
                if (!idempotencyKey) {
                    throw new HttpError(400, 'missing_idempotency_key', 'Envie Idempotency-Key para registrar desgaste.');
                }
                const result = await withMutationQueue(() => applyRaidDurabilityLoss(
                    db,
                    raidKey,
                    playerId,
                    Number(parts[3]),
                    body.amount || body.intensity || body.intensidade,
                    body.cause || body.causa,
                    { idempotencyKey }
                ));
                sendJson(res, 200, result);
                return true;
            }

            if (raidKey && method === 'POST' && parts[2] === 'items' && parts[3] && parts[4] === 'consume') {
                const body = await readJsonBody(req);
                const idempotencyKey = requestIdempotencyKey(req, body);
                if (!idempotencyKey) {
                    throw new HttpError(400, 'missing_idempotency_key', 'Envie Idempotency-Key para registrar consumo.');
                }
                const result = await withMutationQueue(() => consumeRaidItem(
                    db,
                    raidKey,
                    playerId,
                    Number(parts[3]),
                    body.quantity || body.quantidade,
                    body.cause || body.causa,
                    { idempotencyKey }
                ));
                sendJson(res, 200, result);
                return true;
            }

            if (raidKey && method === 'POST' && parts[2] === 'conditions' && parts.length === 3) {
                const body = await readJsonBody(req);
                const result = await withMutationQueue(() => addRaidCondition(db, raidKey, playerId, body));
                sendJson(res, 201, result);
                return true;
            }

            if (raidKey && method === 'POST' && parts[2] === 'conditions' && parts[3] && parts[4] === 'resolve') {
                const body = await readJsonBody(req);
                const result = await withMutationQueue(() => resolveRaidCondition(
                    db,
                    raidKey,
                    playerId,
                    Number(parts[3]),
                    body.note || body.observacao || null
                ));
                sendJson(res, 200, result);
                return true;
            }

            if (raidKey && method === 'POST' && parts[2] === 'rewards' && parts.length === 3) {
                const body = await readJsonBody(req);
                const result = await withMutationQueue(() => addRaidReward(db, raidKey, playerId, body));
                sendJson(res, 201, result);
                return true;
            }

            if (raidKey && method === 'POST' && parts[2] === 'rewards' && parts[3] && parts[4] === 'cancel') {
                const result = await withMutationQueue(() => cancelRaidReward(
                    db,
                    raidKey,
                    playerId,
                    Number(parts[3])
                ));
                sendJson(res, 200, result);
                return true;
            }

            if (raidKey && method === 'POST' && parts[2] === 'complete') {
                const body = await readJsonBody(req);
                const idempotencyKey = requestIdempotencyKey(req, body);
                if (!idempotencyKey) {
                    throw new HttpError(400, 'missing_idempotency_key', 'Envie Idempotency-Key para concluir a raid.');
                }
                const result = await withMutationQueue(() => completeRaid(db, raidKey, playerId, {
                    idempotencyKey,
                }));
                sendJson(res, 200, result);
                return true;
            }
        } catch (error) {
            throw raidHttpError(error);
        }
    }

    if (method === 'GET' && parts[0] === 'inventory') {
        const [summary, items] = await Promise.all([
            getCavalierSummary(db, playerId),
            getStructuredInventory(db, playerId, { limit: 50 }),
        ]);
        sendJson(res, 200, {
            ok: true,
            summary,
            cavaleiro: serializeCavalier(summary),
            items,
            itens: items,
        });
        return true;
    }

    if (method === 'GET' && parts[0] === 'boxes' && parts.length === 1) {
        await requireCanPlay(db, playerId);
        const limit = Number(new URL(req.url, 'http://localhost').searchParams.get('limit') || 20);
        const { dashboard, history } = await withMutationQueue(async () => ({
            dashboard: await getBoxDashboard(db, playerId),
            history: await getBoxHistory(db, playerId, limit),
        }));
        sendJson(res, 200, {
            ok: true,
            dashboard,
            caixas: dashboard,
            history,
            historico: history,
        });
        return true;
    }

    if (method === 'POST' && parts[0] === 'boxes' && parts[1] && parts[2] === 'open') {
        await requireCanPlay(db, playerId);
        const body = await readJsonBody(req);
        const idempotencyKey = String(
            req.headers['idempotency-key']
            || body.idempotencyKey
            || body.idempotency_key
            || ''
        ).trim();
        if (!idempotencyKey) {
            throw new HttpError(400, 'missing_idempotency_key', 'Envie Idempotency-Key para abrir a caixa.');
        }
        try {
            const opening = await withMutationQueue(() => openBox(db, playerId, parts[1], {
                idempotencyKey,
                source: 'site',
            }));
            sendJson(res, 200, { ok: true, opening, abertura: opening });
        } catch (error) {
            throw boxHttpError(error);
        }
        return true;
    }

    if (method === 'GET' && parts[0] === 'ph') {
        const limit = Number(new URL(req.url, 'http://localhost').searchParams.get('limit') || 10);
        const [summary, history] = await Promise.all([
            getPhSummary(db, playerId),
            getPhHistory(db, playerId, limit),
        ]);
        sendJson(res, 200, {
            ok: true,
            summary: serializePhSummary(summary),
            ph: serializePhSummary(summary),
            history,
            historico: history,
        });
        return true;
    }

    if (method === 'GET' && parts[0] === 'yulls') {
        await requireCanPlay(db, playerId);
        const limit = Number(new URL(req.url, 'http://localhost').searchParams.get('limit') || 20);
        const [summary, history] = await Promise.all([
            getYullsSummary(db, playerId),
            getYullsHistory(db, playerId, limit),
        ]);
        sendJson(res, 200, { ok: true, summary, yulls: summary, history, historico: history });
        return true;
    }

    if (method === 'GET' && parts[0] === 'pr') {
        await requireCanPlay(db, playerId);
        const limit = Number(new URL(req.url, 'http://localhost').searchParams.get('limit') || 20);
        const [summary, history] = await Promise.all([
            getPrSummary(db, playerId),
            getPrHistory(db, playerId, limit),
        ]);
        sendJson(res, 200, { ok: true, summary, pr: summary, history, historico: history });
        return true;
    }

    if (method === 'GET' && parts[0] === 'recruitment' && parts[1] === 'shop') {
        await requireCanPlay(db, playerId);
        const dashboard = await withMutationQueue(() => getRecruitmentDashboard(db, playerId));
        sendJson(res, 200, {
            ok: true,
            shop: dashboard.event.shop,
            loja: dashboard.event.shop,
            items: [],
            itens: [],
        });
        return true;
    }

    if (method === 'GET' && parts[0] === 'recruitment' && parts.length === 1) {
        await requireCanPlay(db, playerId);
        const dashboard = await withMutationQueue(() => getRecruitmentDashboard(db, playerId));
        sendJson(res, 200, { ok: true, recruitment: dashboard, recrutamento: dashboard });
        return true;
    }

    if (method === 'POST' && parts[0] === 'recruitment' && parts[1] === 'referrer') {
        await requireCanPlay(db, playerId);
        const body = await readJsonBody(req);
        const code = String(body.code || body.codigo || '').trim();
        if (!code) throw new HttpError(400, 'missing_code', 'Informe o código de recrutamento.');
        try {
            const result = await withMutationQueue(() => submitReferralCode(db, playerId, code, {
                createdBy: playerId,
                via: 'site',
            }));
            const dashboard = await withMutationQueue(() => getRecruitmentDashboard(db, playerId));
            sendJson(res, 200, {
                ok: true,
                referral: result.referral,
                indicacao: result.referral,
                validation: result.validation,
                validacao: result.validation,
                recruitment: dashboard,
                recrutamento: dashboard,
            });
        } catch (error) {
            throw recruitmentHttpError(error);
        }
        return true;
    }

    if (method === 'GET' && parts[0] === 'attributes') {
        const stats = await getCharacterStats(db, playerId);
        sendJson(res, 200, { ok: true, data: serializeAttributes(stats), atributos: serializeAttributes(stats) });
        return true;
    }

    if (method === 'PUT' && parts[0] === 'attributes') {
        await requireCanPlay(db, playerId);
        const body = await readJsonBody(req);
        const values = parseAttributeValues(body);
        const stats = await getCharacterStats(db, playerId);
        const validation = validateDistribution(stats, values);
        if (!validation.ok) {
            throw new HttpError(400, 'invalid_distribution', 'Distribuicao invalida.', validation.errors);
        }

        const result = await withMutationQueue(async () => {
            const saved = await savePendingDistribution(db, playerId, values);
            if (!saved.ok) return saved;
            return confirmPendingDistribution(db, playerId);
        });

        if (!result.ok) {
            throw new HttpError(400, result.reason || 'attribute_update_failed', 'Nao consegui atualizar atributos.', result.validation?.errors || null);
        }

        sendJson(res, 200, {
            ok: true,
            data: serializeAttributes(result.stats),
            validation: result.validation,
        });
        return true;
    }

    if (method === 'GET' && parts[0] === 'trees' && parts.length === 1) {
        sendJson(res, 200, {
            ok: true,
            trees: listTrees().map(serializeTreeDefinition),
        });
        return true;
    }

    if (parts[0] === 'trees' && parts[1]) {
        const treeId = parts[1];

        if (method === 'GET' && parts.length === 2) {
            const state = await getTreeState(db, playerId, treeId);
            sendJson(res, 200, { ok: true, state: serializeTreeState(state) });
            return true;
        }

        if (method === 'POST' && parts[2] === 'purchase') {
            await requireCanPlay(db, playerId);
            const body = await readJsonBody(req);
            const nodeAlias = String(body.nodeId || body.nodeAlias || body.node || '').trim();
            if (!nodeAlias) {
                throw new HttpError(400, 'missing_node', 'Informe nodeId ou nodeAlias.');
            }

            const result = await withMutationQueue(() => buyNode(db, playerId, treeId, nodeAlias, playerId, {
                source: 'site_purchase',
                metadata: { via: 'lovable_site' },
            }));

            if (!result.ok) {
                throw new HttpError(400, result.reason || 'purchase_failed', result.message || 'Compra nao aplicada.', {
                    reason: result.reason,
                    node: result.node || result.details?.node || null,
                    nodeState: result.nodeState || result.details?.nodeState || null,
                    suggestions: result.suggestions || null,
                    matches: result.matches || null,
                });
            }

            sendJson(res, 200, {
                ok: true,
                purchase: {
                    tree: serializeTreeDefinition(result.tree),
                    node: result.node,
                    cost: result.cost,
                    baseCost: result.baseCost,
                    discount: result.discount,
                    purchaseId: result.purchaseId,
                    spend: result.spend,
                },
                state: serializeTreeState(result.state),
            });
            return true;
        }
    }

    return false;
}

async function handleRequest(req, res, options) {
    if (req.method === 'OPTIONS') {
        sendNoContent(res);
        return;
    }

    const db = options.getDb?.();
    if (!db) {
        throw new HttpError(503, 'database_unavailable', 'Banco ainda nao esta pronto.');
    }

    const url = new URL(req.url, 'http://localhost');
    const method = String(req.method || 'GET').toUpperCase();
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (await routePublic(req, res, db, method, parts, url.pathname)) return;

    const auth = await requireAuth(db, req);
    if (await routeAuthed(req, res, db, method, parts, auth, url.pathname)) return;

    throw new HttpError(404, 'not_found', 'Endpoint nao encontrado.');
}

function startSiteApiServer(options = {}) {
    if (!isSiteApiEnabled()) return null;
    activeOptions = options;
    if (activeServer) return activeServer;
    if (retryTimer) return null;

    const server = http.createServer((req, res) => {
        const requestId = resolveRequestId(req);
        const method = String(req.method || 'GET').toUpperCase();
        const pathname = safeRequestPath(req);
        const operation = `${method} ${pathname}`;
        const startedAt = Date.now();

        res.setHeader('X-Request-Id', requestId);
        res.once('finish', () => {
            console.log('[site-api] request', JSON.stringify({
                requestId,
                method,
                pathname,
                status: res.statusCode,
                durationMs: Date.now() - startedAt,
            }));
        });

        requestContext.run({ requestId, operation }, () => {
            handleRequest(req, res, options).catch((error) => {
                const status = error instanceof HttpError ? error.status : 500;
                const code = error instanceof HttpError ? error.code : 'internal_error';
                const message = error instanceof HttpError ? error.message : 'Erro interno.';
                if (!(error instanceof HttpError)) {
                    console.log('[site-api] internal_error', JSON.stringify({
                        requestId,
                        method,
                        pathname,
                        error: error?.stack || error?.message || String(error),
                    }));
                }
                if (!res.headersSent) {
                    if (code === 'economy_queue_busy') res.setHeader('Retry-After', '3');
                    sendJson(res, status, {
                        ok: false,
                        error: code,
                        message,
                        requestId,
                        details: error instanceof HttpError ? error.details : null,
                    });
                } else {
                    res.end();
                }
            });
        });
    });

    server.on('error', (error) => {
        if (activeServer === server) {
            activeServer = null;
        }
        if (error?.code === 'EADDRINUSE') {
            const retryMs = 3000;
            console.log(`[site-api] porta ocupada (${siteApiHost()}:${siteApiPort()}); tentando de novo em ${retryMs / 1000}s.`);
            retryTimer = setTimeout(() => {
                retryTimer = null;
                startSiteApiServer(activeOptions || options);
            }, retryMs);
            retryTimer.unref?.();
            return;
        }
        console.log('[site-api] erro no servidor:', error?.message || error);
    });

    const port = siteApiPort();
    const host = siteApiHost();
    server.listen(port, host, () => {
        console.log(`[site-api] online em http://${host}:${port}`);
    });

    activeServer = server;
    return server;
}

function stopSiteApiServer() {
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
    if (!activeServer) return Promise.resolve();
    const server = activeServer;
    activeServer = null;
    return new Promise((resolve) => {
        server.close(() => resolve());
    });
}

module.exports = {
    __test: Object.freeze({ handleRequest, routeAuthed, routePublic }),
    isSiteApiEnabled,
    startSiteApiServer,
    stopSiteApiServer,
};
