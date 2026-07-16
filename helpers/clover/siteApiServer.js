const http = require('http');

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
let mutationTail = Promise.resolve();

const CORS_HEADERS = 'Content-Type, Authorization, ngrok-skip-browser-warning';

class HttpError extends Error {
    constructor(status, code, message, details = null) {
        super(message || code);
        this.status = status;
        this.code = code;
        this.details = details;
    }
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
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
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
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
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
    const previous = mutationTail.catch(() => {});
    let releaseCurrent;
    mutationTail = new Promise((resolve) => {
        releaseCurrent = resolve;
    });

    await previous;
    try {
        return await action();
    } finally {
        releaseCurrent();
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
    const percepcao = Number(hexagon.percepcao || 1);
    const retencao = Number(hexagon.retencao || 1);
    const emissao = Number(hexagon.emissao || 1);
    const controle = Number(hexagon.controle || 1);
    const pressao = Number(hexagon.pressao || 1);
    const alcance = Number(hexagon.alcance || 1);
    const limits = getHexagonDerivedLimits(hexagon);

    return {
        PER: percepcao,
        RET: retencao,
        EMI: emissao,
        CON: controle,
        PRE: pressao,
        ALC: alcance,
        percepcao,
        retencao,
        emissao,
        controle,
        pressao,
        alcance,
        limites: {
            alcance: limits.alcanceLabel,
            area: limits.areaLabel,
            duracao: limits.duracaoLabel,
            impacto_mana: limits.pressaoBonus,
            controle: limits.controleLabel,
            emissao: limits.emissaoLabel,
            percepcao: limits.percepcaoLabel,
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

async function routePublic(req, res, db, method, parts) {
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
                'GET /status',
                'GET /bonus',
                'GET /capabilities',
                'GET /hexagono',
                'POST /hexagono',
                'GET /attributes',
                'PUT /attributes',
                'GET /inventory',
                'GET /ph',
                'GET /trees',
                'GET /trees/:treeId',
                'POST /trees/:treeId/purchase',
            ],
        });
        return true;
    }

    if (method === 'GET' && parts[0] === 'health') {
        sendJson(res, 200, { ok: true, status: 'online' });
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

async function routeAuthed(req, res, db, method, parts, auth) {
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
                updatedAt: player.personagem_aparencia_updated_at || null,
                approvedAt: player.personagem_aparencia_approved_at || null,
                reason: player.personagem_aparencia_motivo || null,
            },
            aparencia: {
                status: player.personagem_aparencia_status || null,
                texto: player.personagem_aparencia || null,
                imagem: player.personagem_aparencia_image_path || null,
                atualizada_em: player.personagem_aparencia_updated_at || null,
                aprovada_em: player.personagem_aparencia_approved_at || null,
                motivo: player.personagem_aparencia_motivo || null,
            },
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

    if (method === 'GET' && parts[0] === 'inventory') {
        const [summary, items] = await Promise.all([
            getCavalierSummary(db, playerId),
            getInventoryItems(db, playerId, 50),
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
                throw new HttpError(400, result.reason || 'purchase_failed', 'Compra nao aplicada.', {
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

    if (await routePublic(req, res, db, method, parts)) return;

    const auth = await requireAuth(db, req);
    if (await routeAuthed(req, res, db, method, parts, auth)) return;

    throw new HttpError(404, 'not_found', 'Endpoint nao encontrado.');
}

function startSiteApiServer(options = {}) {
    if (!isSiteApiEnabled()) return null;
    activeOptions = options;
    if (activeServer) return activeServer;
    if (retryTimer) return null;

    const server = http.createServer((req, res) => {
        handleRequest(req, res, options).catch((error) => {
            const status = error instanceof HttpError ? error.status : 500;
            const code = error instanceof HttpError ? error.code : 'internal_error';
            const message = error instanceof HttpError ? error.message : 'Erro interno.';
            if (!(error instanceof HttpError)) {
                console.log('[site-api] erro:', error?.stack || error?.message || error);
            }
            if (!res.headersSent) {
                sendJson(res, status, {
                    ok: false,
                    error: code,
                    message,
                    details: error instanceof HttpError ? error.details : null,
                });
            } else {
                res.end();
            }
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
    isSiteApiEnabled,
    startSiteApiServer,
    stopSiteApiServer,
};
