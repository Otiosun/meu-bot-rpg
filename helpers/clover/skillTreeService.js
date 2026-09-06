const { ensureCloverSkillTreeSchema } = require('../../database');
const { getClosestTextMatches } = require('../textUtils');
const { applyTreeDiscountCost, getTreeDiscountForPlayer } = require('./characterBonusService');
const { ensurePhState, getPhSummary, spendPhInTransaction } = require('./phService');
const { getTree, normalizeKey } = require('./treeLoader');

const PURCHASE_PENDING_MINUTES = 15;
const STAGE_ORDER = ['9', '8', '7', '6', '5', '4', '3', '2', '1', '0', 'arcano'];
const SENSE_TIER_ORDER = { basic: 0, developed: 1, advanced: 2, master: 3 };

class SkillTreeError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'SkillTreeError';
        this.code = code;
    }
}

async function ensureSkillTreeState(db, playerId) {
    await ensureCloverSkillTreeSchema(db);
    await ensurePhState(db, playerId);
}

function safeJsonParse(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function serializeMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') return null;
    return JSON.stringify(metadata);
}

function isCopyOrCorpseSoulMagic(player = {}) {
    const magic = normalizeKey(`${player.magia || ''} ${player.magia_key || ''}`);
    return magic.includes('copia')
        || magic.includes('imitacao copia')
        || magic.includes('cadaver da alma')
        || magic.includes('cadaver');
}

async function getForbiddenMagicTreeGuard(db, playerId, treeId) {
    const normalizedTreeId = normalizeKey(treeId);
    if (!['criacao', 'reforco'].includes(normalizedTreeId)) return null;
    const player = await db.get(
        'SELECT id, nome, personagem_nome, magia, magia_key FROM jogadores WHERE id = ?',
        [playerId]
    );
    if (!isCopyOrCorpseSoulMagic(player)) return null;
    return {
        ok: false,
        reason: 'forbidden_magic_tree',
        treeId: normalizedTreeId,
        player,
        message: 'Magias de Copia/Cadaver da Alma nao podem comprar Criacao ou Reforco. Use Mana, Suporte, Fisico e caminhos aprovados pela ADM.',
    };
}

function isPendingExpired(row) {
    return row?.expires_at && new Date(row.expires_at).getTime() <= Date.now();
}

function hydratePendingPurchase(row) {
    if (!row) return null;
    const tree = getTree(row.tree_id);
    const node = tree?.nodesById[row.node_id] || null;
    return { ...row, tree, node, metadata: safeJsonParse(row.metadata_json, {}) };
}

function nodeLabel(tree, nodeId) {
    return tree.nodesById[nodeId]?.name || nodeId;
}

function routeLabel(tree, routeId) {
    return tree.routesById[routeId]?.name || routeId;
}

function anyRequirementLabel(tree, group) {
    return (group || []).map((nodeId) => nodeLabel(tree, nodeId)).join(' ou ');
}

function withNumberVariants(value) {
    const normalized = normalizeKey(value);
    const variants = new Set([normalized]);
    variants.add(normalized.replace(/\bii\b/g, '2'));
    variants.add(normalized.replace(/\bi\b/g, '1'));
    variants.add(normalized.replace(/\b2\b/g, 'ii'));
    variants.add(normalized.replace(/\b1\b/g, 'i'));
    variants.add(normalized.replace(/\bde mana\b/g, '').replace(/\s+/g, ' ').trim());
    variants.add(normalized.replace(/\bmana\b/g, '').replace(/\s+/g, ' ').trim());
    return [...variants].filter(Boolean);
}

function getNodeAliases(node) {
    return [...new Set([
        node.id.replace(/_/g, ' '),
        node.name,
        ...(node.aliases || []),
    ].flatMap(withNumberVariants))];
}

function getRouteAliases(route) {
    return [route.id, route.name, `rota ${route.name}`, `rota ${route.id}`].flatMap(withNumberVariants);
}

function resolveNodeAlias(tree, nodeAlias) {
    const input = normalizeKey(nodeAlias);
    if (!input) return { ok: false, reason: 'missing_input', suggestions: tree.nodes.slice(0, 5).map((node) => node.name) };
    const indexed = tree.nodes.map((node) => ({ node, aliases: getNodeAliases(node) }));
    const exact = indexed.filter((item) => item.aliases.includes(input));
    if (exact.length === 1) return { ok: true, node: exact[0].node };
    if (exact.length > 1) return { ok: false, reason: 'ambiguous', matches: exact.map((item) => item.node) };
    const partial = indexed.filter((item) => item.aliases.some((alias) => alias.includes(input) || input.includes(alias)));
    if (partial.length === 1) return { ok: true, node: partial[0].node };
    if (partial.length > 1) return { ok: false, reason: 'ambiguous', matches: partial.map((item) => item.node) };
    const suggestions = getClosestTextMatches(input, tree.nodes.map((node) => ({ label: node.name, key: node.id })), 5);
    return { ok: false, reason: 'not_found', suggestions };
}

function resolveRouteAlias(tree, routeAlias) {
    const input = normalizeKey(routeAlias);
    if (!input) return { ok: false, reason: 'missing_input' };
    const indexed = tree.routes.map((route) => ({ route, aliases: getRouteAliases(route) }));
    const exact = indexed.filter((item) => item.aliases.includes(input));
    if (exact.length === 1) return { ok: true, route: exact[0].route };
    if (exact.length > 1) return { ok: false, reason: 'ambiguous', matches: exact.map((item) => item.route) };
    const partial = indexed.filter((item) => item.aliases.some((alias) => alias.includes(input) || input.includes(alias)));
    if (partial.length === 1) return { ok: true, route: partial[0].route };
    if (partial.length > 1) return { ok: false, reason: 'ambiguous', matches: partial.map((item) => item.route) };
    const suggestions = getClosestTextMatches(input, tree.routes.map((route) => ({ label: route.name, key: route.id })), 4);
    return { ok: false, reason: 'not_found', suggestions };
}

async function getOwnedNodeIds(db, playerId, treeId) {
    await ensureSkillTreeState(db, playerId);
    const rows = await db.all(
        `SELECT node_id FROM clover_skill_nodes WHERE player_id = ? AND tree_id = ? ORDER BY purchased_at ASC, id ASC`,
        [playerId, treeId]
    );
    return rows.map((row) => row.node_id);
}

function stageMeetsFloor(stageKey, floorKey) {
    if (!floorKey) return true;
    const current = STAGE_ORDER.indexOf(String(stageKey || '9'));
    const floor = STAGE_ORDER.indexOf(String(floorKey));
    if (floor < 0) return true;
    return Math.max(0, current) >= floor;
}

function getOwnedSemanticSummary(tree, ownedIds) {
    const physical = new Map();
    const senses = new Map();
    for (const id of ownedIds || []) {
        const node = tree.nodesById[id];
        if (!node) continue;
        const meta = node.metadata || {};
        if (meta.physicalLine) {
            physical.set(meta.physicalLine, Math.max(Number(meta.rank || 0), Number(physical.get(meta.physicalLine) || 0)));
        }
        if (meta.senseChannel) {
            const previous = senses.get(meta.senseChannel) || { rank: 0, tier: 'basic' };
            const tier = meta.senseTier || 'basic';
            const previousTier = SENSE_TIER_ORDER[previous.tier] ?? 0;
            const currentTier = SENSE_TIER_ORDER[tier] ?? 0;
            senses.set(meta.senseChannel, {
                rank: Math.max(Number(previous.rank || 0), Number(meta.rank || 0)),
                tier: currentTier >= previousTier ? tier : previous.tier,
            });
        }
    }
    return { physical, senses };
}

function evaluateSkillGate(tree, node, ownedIds) {
    const gate = node?.metadata?.skillGate;
    if (!gate) return { ok: true, missingLabels: [] };
    const { physical, senses } = getOwnedSemanticSummary(tree, ownedIds);
    const missingLabels = [];

    if (gate.physical) {
        const requiredRank = Number(gate.physical.rank || 1);
        const minDistinct = Number(gate.physical.minDistinct || 1);
        const qualified = [...physical.values()].filter((rank) => rank >= requiredRank).length;
        if (qualified < minDistinct) missingLabels.push(`${minDistinct} linha(s) física(s) em rank ${requiredRank}+`);
        if (gate.physical.oneAtRank) {
            const high = [...physical.values()].some((rank) => rank >= Number(gate.physical.oneAtRank));
            if (!high) missingLabels.push(`1 linha física em rank ${gate.physical.oneAtRank}+`);
        }
    }

    if (gate.senses) {
        const minDistinct = Number(gate.senses.minDistinct || 1);
        const minTier = SENSE_TIER_ORDER[gate.senses.tier || 'developed'] ?? 1;
        const qualified = [...senses.values()].filter((item) => (SENSE_TIER_ORDER[item.tier] ?? 0) >= minTier).length;
        if (qualified < minDistinct) missingLabels.push(`${minDistinct} canal(is) sensorial(is) ${gate.senses.tier || 'developed'}+`);
        if (gate.senses.oneAtTier) {
            const need = SENSE_TIER_ORDER[gate.senses.oneAtTier] ?? 0;
            const high = [...senses.values()].some((item) => (SENSE_TIER_ORDER[item.tier] ?? 0) >= need);
            if (!high) missingLabels.push(`1 canal sensorial ${gate.senses.oneAtTier}+`);
        }
    }

    if (gate.orSense) {
        const masterNeed = Number(gate.orSense.master || 0);
        const advancedNeed = Number(gate.orSense.advanced || 0);
        const values = [...senses.values()];
        const masters = values.filter((item) => (SENSE_TIER_ORDER[item.tier] ?? 0) >= SENSE_TIER_ORDER.master).length;
        const advanced = values.filter((item) => (SENSE_TIER_ORDER[item.tier] ?? 0) >= SENSE_TIER_ORDER.advanced).length;
        if (masters < masterNeed && advanced < advancedNeed) {
            missingLabels.push(`${masterNeed} canal Mestre OU ${advancedNeed} canais Avançados`);
        }
    }

    return { ok: missingLabels.length === 0, missingLabels };
}

function getRequirementState(tree, node, ownedIds) {
    const ownedSet = new Set(ownedIds);
    const missing = (node.requires || []).filter((nodeId) => !ownedSet.has(nodeId));
    const satisfied = (node.requires || []).filter((nodeId) => ownedSet.has(nodeId));
    const anyGroups = Array.isArray(node.requiresAny) ? node.requiresAny : [];
    const missingAny = anyGroups.filter((group) => !group.some((nodeId) => ownedSet.has(nodeId)));
    const satisfiedAny = anyGroups.filter((group) => group.some((nodeId) => ownedSet.has(nodeId)));
    const semanticGate = evaluateSkillGate(tree, node, ownedIds);
    return {
        missing,
        missingAny,
        semanticGate,
        missingLabels: [
            ...missing.map((nodeId) => nodeLabel(tree, nodeId)),
            ...missingAny.map((group) => anyRequirementLabel(tree, group)),
            ...semanticGate.missingLabels,
        ],
        satisfied,
        satisfiedAny,
        satisfiedLabels: [
            ...satisfied.map((nodeId) => nodeLabel(tree, nodeId)),
            ...satisfiedAny.map((group) => anyRequirementLabel(tree, group)),
        ],
    };
}

function getNodeStatus(tree, node, ownedIds, phAvailable, effectiveCost = Number(node?.cost || 0), discount = null, context = {}) {
    const baseCost = Number(node?.cost || 0);
    const cost = Number(effectiveCost ?? baseCost);
    const ownedSet = new Set(ownedIds);
    if (ownedSet.has(node.id)) return { status: 'owned', missingPh: 0, missingRequirements: [], missingRequirementLabels: [], baseCost, effectiveCost: cost, discount };

    const requirements = getRequirementState(tree, node, ownedIds);
    const floor = node?.metadata?.stageFloor;
    const stageLocked = !stageMeetsFloor(context.stageKey, floor);
    const missingLabels = [...requirements.missingLabels];
    if (stageLocked) missingLabels.push(`Estágio ${floor}º+`);
    const missingPh = Math.max(0, cost - Number(phAvailable || 0));

    if (requirements.missing.length || requirements.missingAny.length || !requirements.semanticGate.ok || stageLocked) {
        return {
            status: 'locked', missingPh,
            missingRequirements: requirements.missing,
            missingAnyRequirements: requirements.missingAny,
            missingRequirementLabels: missingLabels,
            satisfiedRequirements: requirements.satisfied,
            satisfiedAnyRequirements: requirements.satisfiedAny,
            satisfiedRequirementLabels: requirements.satisfiedLabels,
            baseCost, effectiveCost: cost, discount,
        };
    }
    if (missingPh > 0) return {
        status: 'no_ph', missingPh, missingRequirements: [], missingRequirementLabels: [],
        satisfiedRequirements: requirements.satisfied, satisfiedRequirementLabels: requirements.satisfiedLabels,
        baseCost, effectiveCost: cost, discount,
    };
    if (node.requiresApproval) return {
        status: 'approval', missingPh: 0, missingRequirements: [], missingRequirementLabels: [],
        satisfiedRequirements: requirements.satisfied, satisfiedRequirementLabels: requirements.satisfiedLabels,
        baseCost, effectiveCost: cost, discount,
    };
    return {
        status: 'available', missingPh: 0, missingRequirements: [], missingRequirementLabels: [],
        satisfiedRequirements: requirements.satisfied, satisfiedRequirementLabels: requirements.satisfiedLabels,
        baseCost, effectiveCost: cost, discount,
    };
}

function getRouteProgress(tree, ownedIds) {
    const ownedSet = new Set(ownedIds);
    return tree.routes.map((route) => {
        const nodes = tree.nodes.filter((node) => node.route === route.id);
        const owned = nodes.filter((node) => ownedSet.has(node.id));
        return { route, owned: owned.length, total: nodes.length, nodes };
    });
}

async function getTreeState(db, playerId, treeId = 'mana') {
    const tree = getTree(treeId);
    if (!tree) throw new SkillTreeError('tree_not_found', 'Arvore nao encontrada.');
    await ensureSkillTreeState(db, playerId);
    const ph = await getPhSummary(db, playerId);
    const ownedIds = await getOwnedNodeIds(db, playerId, tree.id);
    const discount = await getTreeDiscountForPlayer(db, playerId, tree.id);
    const nodeStates = tree.nodes.map((node) => ({
        node,
        ...getNodeStatus(tree, node, ownedIds, ph.phAvailable, applyTreeDiscountCost(node.cost, discount.percent), discount, { stageKey: ph.stageKey }),
    }));
    const availableNodes = nodeStates.filter((item) => item.status === 'available');
    return {
        playerId, tree, ph, ownedIds, ownedSet: new Set(ownedIds),
        routeProgress: getRouteProgress(tree, ownedIds), nodeStates, availableNodes, discount,
        totalNodes: tree.nodes.length, ownedCount: ownedIds.length,
    };
}

async function getAvailableNodes(db, playerId, treeId = 'mana') {
    return (await getTreeState(db, playerId, treeId)).availableNodes;
}

async function getNodeDetails(db, playerId, treeId, nodeAlias) {
    const state = await getTreeState(db, playerId, treeId);
    const resolution = resolveNodeAlias(state.tree, nodeAlias);
    if (!resolution.ok) return { ok: false, ...resolution, state };
    const nodeState = state.nodeStates.find((item) => item.node.id === resolution.node.id);
    return {
        ok: true, state, node: resolution.node, nodeState,
        route: state.tree.routesById[resolution.node.route],
        unlocks: (resolution.node.unlocks || []).map((nodeId) => state.tree.nodesById[nodeId]).filter(Boolean),
    };
}

function isPurchasableStatus(status, { allowApproval = false } = {}) {
    return status === 'available' || (allowApproval && status === 'approval');
}

async function clearPendingPurchase(db, playerId) {
    await ensureCloverSkillTreeSchema(db);
    await db.run('DELETE FROM clover_pending_skill_purchases WHERE player_id = ?', [playerId]);
}

async function getPendingPurchase(db, playerId) {
    await ensureCloverSkillTreeSchema(db);
    const row = await db.get('SELECT * FROM clover_pending_skill_purchases WHERE player_id = ?', [playerId]);
    if (!row) return null;
    if (isPendingExpired(row)) {
        await clearPendingPurchase(db, playerId);
        return null;
    }
    return hydratePendingPurchase(row);
}

async function createPendingPurchase(db, playerId, treeId, nodeAlias, createdBy, source = 'comando_comprar') {
    const forbidden = await getForbiddenMagicTreeGuard(db, playerId, treeId);
    if (forbidden) return forbidden;
    const details = await getNodeDetails(db, playerId, treeId, nodeAlias);
    if (!details.ok) return details;
    if (!isPurchasableStatus(details.nodeState.status)) return { ok: false, reason: 'not_available', details, state: details.state };
    const expiresAt = new Date(Date.now() + PURCHASE_PENDING_MINUTES * 60 * 1000).toISOString();
    const metadata = {
        cost: Number(details.nodeState.effectiveCost ?? Number(details.node.cost || 0)),
        base_cost: Number(details.node.cost || 0),
        discount_percent: Number(details.nodeState.discount?.percent || 0),
        discount_sources: details.nodeState.discount?.sources || [],
        node_name: details.node.name,
    };
    await db.run(
        `INSERT INTO clover_pending_skill_purchases
         (player_id, tree_id, node_id, created_by, source, created_at, expires_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET
         tree_id = excluded.tree_id, node_id = excluded.node_id, created_by = excluded.created_by,
         source = excluded.source, created_at = CURRENT_TIMESTAMP, expires_at = excluded.expires_at,
         metadata_json = excluded.metadata_json`,
        [playerId, details.state.tree.id, details.node.id, createdBy, source, expiresAt, JSON.stringify(metadata)]
    );
    return { ok: true, details, expiresAt };
}

async function buyNode(db, playerId, treeId, nodeAlias, createdBy, options = {}) {
    const tree = getTree(treeId);
    if (!tree) return { ok: false, reason: 'tree_not_found' };
    const forbidden = await getForbiddenMagicTreeGuard(db, playerId, tree.id);
    if (forbidden) return { ...forbidden, tree };
    await ensureSkillTreeState(db, playerId);
    const resolution = resolveNodeAlias(tree, nodeAlias);
    if (!resolution.ok) return { ok: false, ...resolution };

    await db.exec('BEGIN IMMEDIATE');
    try {
        const ph = await getPhSummary(db, playerId);
        const ownedIds = await db.all(
            'SELECT node_id FROM clover_skill_nodes WHERE player_id = ? AND tree_id = ?',
            [playerId, tree.id]
        ).then((rows) => rows.map((row) => row.node_id));
        const discount = await getTreeDiscountForPlayer(db, playerId, tree.id);
        const baseCost = Number(resolution.node.cost || 0);
        const effectiveCost = applyTreeDiscountCost(baseCost, discount.percent);
        const nodeState = getNodeStatus(tree, resolution.node, ownedIds, ph.phAvailable, effectiveCost, discount, { stageKey: ph.stageKey });
        if (!isPurchasableStatus(nodeState.status, { allowApproval: options.allowApproval === true })) {
            await db.exec('ROLLBACK');
            return { ok: false, reason: 'not_available', node: resolution.node, nodeState, ph };
        }
        const insert = await db.run(
            `INSERT INTO clover_skill_nodes
             (player_id, tree_id, node_id, purchased_at, purchased_by, source, metadata_json)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)`,
            [playerId, tree.id, resolution.node.id, createdBy, options.source || 'skill_tree_purchase', serializeMetadata({
                node_name: resolution.node.name, cost: effectiveCost, base_cost: baseCost,
                discount_percent: Number(discount.percent || 0), discount_sources: discount.sources || [],
                ...(options.metadata || {}),
            })]
        );
        const spend = await spendPhInTransaction(
            db, playerId, effectiveCost, `skill_tree:${tree.id}`, `Compra de no: ${resolution.node.name}`,
            createdBy, { tree_id: tree.id, node_id: resolution.node.id, node_name: resolution.node.name,
                purchase_id: insert.lastID, base_cost: baseCost, discount_percent: Number(discount.percent || 0),
                discount_sources: discount.sources || [] }, `${tree.id}:${resolution.node.id}`
        );
        await db.exec('COMMIT');
        return {
            ok: true, tree, node: resolution.node, nodeState, cost: effectiveCost, baseCost, discount,
            purchaseId: insert.lastID, spend, state: await getTreeState(db, playerId, tree.id),
        };
    } catch (error) {
        await db.exec('ROLLBACK');
        if (String(error?.message || '').includes('UNIQUE')) return { ok: false, reason: 'already_owned', node: resolution.node };
        throw error;
    }
}

async function confirmPendingPurchase(db, playerId, createdBy = null) {
    await ensureCloverSkillTreeSchema(db);
    const row = await db.get('SELECT * FROM clover_pending_skill_purchases WHERE player_id = ?', [playerId]);
    if (!row) return { ok: false, reason: 'missing_pending' };
    if (isPendingExpired(row)) {
        await clearPendingPurchase(db, playerId);
        return { ok: false, reason: 'expired_pending', pending: hydratePendingPurchase(row) };
    }
    const pending = hydratePendingPurchase(row);
    const result = await buyNode(db, playerId, pending.tree_id, pending.node_id, createdBy || pending.created_by || playerId, {
        source: pending.source || 'skill_tree_pending', metadata: { pending_created_at: pending.created_at },
    });
    if (result.ok || result.reason === 'already_owned') await clearPendingPurchase(db, playerId);
    return { ...result, pending };
}

async function cancelPendingPurchase(db, playerId) {
    const pending = await getPendingPurchase(db, playerId);
    if (!pending) return { ok: false, reason: 'missing_pending' };
    await clearPendingPurchase(db, playerId);
    return { ok: true, pending };
}

module.exports = {
    SkillTreeError,
    buyNode,
    cancelPendingPurchase,
    clearPendingPurchase,
    confirmPendingPurchase,
    createPendingPurchase,
    getAvailableNodes,
    getNodeDetails,
    getNodeStatus,
    getOwnedNodeIds,
    getPendingPurchase,
    getRouteProgress,
    getTreeState,
    resolveNodeAlias,
    resolveRouteAlias,
    routeLabel,
};
