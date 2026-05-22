const { getTree } = require('./arvores');

function normalizeText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function safeJsonParse(value, fallback) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : fallback;
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function getNodeName(tree, nodeId) {
    return tree.nodesById[nodeId]?.name || nodeId;
}

function buildAnyRequirementLabel(tree, group) {
    return group.map((nodeId) => getNodeName(tree, nodeId)).join(' ou ');
}

async function ensureProgressRow(db, playerId) {
    await db.run(
        `INSERT OR IGNORE INTO player_progress (player_id, ph_total, ph_bonus, updated_at)
         VALUES (?, 0, 0, CURRENT_TIMESTAMP)`,
        [playerId]
    );
}

async function ensureTreeStateRow(db, playerId, tree) {
    await db.run(
        `INSERT OR IGNORE INTO player_skill_trees
         (player_id, tree, ph_spent, unlocked_node_ids, narrative_flags, last_purchase, last_prox_options, purchase_history, updated_at)
         VALUES (?, ?, 0, '[]', '[]', NULL, '[]', '[]', CURRENT_TIMESTAMP)`,
        [playerId, tree.key]
    );
}

async function ensureAutoUnlocks(db, row, tree) {
    const unlockedNodeIds = safeJsonParse(row.unlocked_node_ids, []);
    const merged = unique([...tree.autoUnlockNodeIds, ...unlockedNodeIds]);

    if (merged.length === unlockedNodeIds.length) return merged;

    await db.run(
        `UPDATE player_skill_trees
         SET unlocked_node_ids = ?, updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ? AND tree = ?`,
        [JSON.stringify(merged), row.player_id, tree.key]
    );

    return merged;
}

async function getLegacyPhTotal(db, playerId, tree) {
    if (!tree.legacyPhSource?.table || !tree.legacyPhSource?.column) return 0;

    const row = await db.get(
        `SELECT ${tree.legacyPhSource.column} AS legacy_total
         FROM ${tree.legacyPhSource.table}
         WHERE id = ?`,
        [playerId]
    );

    return Number(row?.legacy_total || 0);
}

function buildCustomRequirementContext(playerState) {
    return {
        hasNode: (nodeId) => playerState.unlockedSet.has(nodeId),
        getTrackSpentPh: (trackKey) => getTrackSpentPh(playerState, trackKey),
        getSectionSpentPh: (sectionKey) => getSectionSpentPh(playerState, sectionKey),
        getUnlockedCountInTrack: (trackKey) => {
            const track = playerState.tree.purchaseTracks[trackKey];
            if (!track) return 0;
            return track.ids.filter((nodeId) => playerState.unlockedSet.has(nodeId)).length;
        },
        playerState,
    };
}

function evaluateCustomRequirement(playerState, requirementKey) {
    const definition = playerState.tree.customRequirements?.[requirementKey];
    if (!definition) {
        return { ok: true, label: requirementKey };
    }

    if (typeof definition.check !== 'function') {
        return { ok: true, label: definition.label || requirementKey, hint: definition.hint || '' };
    }

    const ok = Boolean(definition.check(buildCustomRequirementContext(playerState)));
    return {
        ok,
        label: definition.label || requirementKey,
        hint: definition.hint || '',
    };
}

function hydratePlayerState(tree, playerRow, progressRow, treeRow) {
    const unlockedNodeIds = unique(safeJsonParse(treeRow.unlocked_node_ids, []));
    const narrativeFlags = unique(safeJsonParse(treeRow.narrative_flags, []));
    const purchaseHistory = safeJsonParse(treeRow.purchase_history, []);
    const lastPurchase = treeRow.last_purchase ? safeJsonParse(treeRow.last_purchase, null) : null;
    const lastProxOptions = unique(safeJsonParse(treeRow.last_prox_options, []));
    const phTotal = Math.max(Number(progressRow.ph_total || 0), Number(progressRow.legacy_ph_total || 0)) + Number(progressRow.ph_bonus || 0);
    const phSpent = Number(treeRow.ph_spent || 0);
    const phAvailable = Math.max(0, phTotal - phSpent);

    const state = {
        playerId: playerRow.id,
        player: playerRow,
        tree,
        treeKey: tree.key,
        unlockedNodeIds,
        unlockedSet: new Set(unlockedNodeIds),
        narrativeFlags,
        narrativeFlagSet: new Set(narrativeFlags.map(normalizeText)),
        lastPurchase,
        lastProxOptions,
        purchaseHistory,
        ph: {
            total: phTotal,
            spent: phSpent,
            available: phAvailable,
            legacy: Number(progressRow.legacy_ph_total || 0),
            manual: Number(progressRow.ph_total || 0),
            bonus: Number(progressRow.ph_bonus || 0),
        },
    };

    return state;
}

async function getPlayerSkillState(db, playerId, treeKey) {
    const tree = getTree(treeKey);
    if (!tree) throw new Error(`Árvore inválida: ${treeKey}`);

    const playerRow = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    if (!playerRow) return null;

    await ensureProgressRow(db, playerId);
    await ensureTreeStateRow(db, playerId, tree);

    const legacyTotal = await getLegacyPhTotal(db, playerId, tree);
    const progressRow = await db.get(
        `SELECT player_id, ph_total, ph_bonus, ? AS legacy_ph_total
         FROM player_progress
         WHERE player_id = ?`,
        [legacyTotal, playerId]
    );

    const treeRow = await db.get(
        `SELECT *
         FROM player_skill_trees
         WHERE player_id = ? AND tree = ?`,
        [playerId, tree.key]
    );

    const unlockedNodeIds = await ensureAutoUnlocks(db, treeRow, tree);
    const hydratedTreeRow = {
        ...treeRow,
        unlocked_node_ids: JSON.stringify(unlockedNodeIds),
    };

    return hydratePlayerState(tree, playerRow, progressRow, hydratedTreeRow);
}

function getTrackCurrentNode(playerState, trackKey) {
    const track = playerState.tree.purchaseTracks[trackKey];
    if (!track) return null;

    let current = null;
    for (const nodeId of track.ids) {
        if (playerState.unlockedSet.has(nodeId)) current = playerState.tree.nodesById[nodeId];
    }
    return current;
}

function getNextNodeForBranch(playerState, branchKey) {
    const track = playerState.tree.purchaseTracks[branchKey];
    if (!track) return null;

    for (const nodeId of track.ids) {
        if (!playerState.unlockedSet.has(nodeId)) {
            return playerState.tree.nodesById[nodeId];
        }
    }

    return null;
}

function getTrackSpentPh(playerState, trackKey) {
    const track = playerState.tree.purchaseTracks[trackKey];
    if (!track) return 0;

    return track.ids.reduce((total, nodeId) => {
        if (!playerState.unlockedSet.has(nodeId)) return total;
        return total + Number(playerState.tree.nodesById[nodeId]?.cost_ph || 0);
    }, 0);
}

function getSectionSpentPh(playerState, sectionKey) {
    return playerState.unlockedNodeIds.reduce((total, nodeId) => {
        const node = playerState.tree.nodesById[nodeId];
        if (!node || node.section !== sectionKey) return total;
        return total + Number(node.cost_ph || 0);
    }, 0);
}

function getNodeByAlias(input, treeKey, playerState = null) {
    const tree = typeof treeKey === 'string' ? getTree(treeKey) : treeKey;
    if (!tree) return null;

    const normalizedInput = normalizeText(input);
    if (!normalizedInput) return null;

    const exactNode = tree.nodes.find((node) => node.aliases.some((alias) => normalizeText(alias) === normalizedInput));
    if (exactNode) return exactNode;

    const branch = Object.values(tree.purchaseTracks).find((track) =>
        track.aliases.some((alias) => normalizeText(alias) === normalizedInput)
    );
    const branchKey = branch?.key;

    if (!branchKey) return null;
    if (!playerState) return { branchKey };

    return getNextNodeForBranch(playerState, branchKey);
}

function canPurchaseNode(playerState, node) {
    if (!node) {
        return {
            ok: false,
            missing_ph: 0,
            missing_requires: ['Habilidade inválida'],
            missing_any_requires: [],
            missing_narrative: [],
            missing_custom_requires: [],
            already_unlocked: false,
            satisfied_requires: [],
        };
    }

    if (playerState.unlockedSet.has(node.id)) {
        return {
            ok: false,
            missing_ph: 0,
            missing_requires: [],
            missing_any_requires: [],
            missing_narrative: [],
            missing_custom_requires: [],
            already_unlocked: true,
            satisfied_requires: [],
        };
    }

    const missingRequires = [];
    const satisfiedRequires = [];

    for (const requiredNodeId of node.requires || []) {
        const label = getNodeName(playerState.tree, requiredNodeId);
        if (playerState.unlockedSet.has(requiredNodeId)) satisfiedRequires.push(label);
        else missingRequires.push(label);
    }

    const missingAnyRequires = [];
    const satisfiedAnyRequires = [];

    for (const group of node.requires_any || []) {
        const unlockedFromGroup = group.filter((requiredNodeId) => playerState.unlockedSet.has(requiredNodeId));
        if (unlockedFromGroup.length > 0) {
            satisfiedAnyRequires.push(...unlockedFromGroup.map((requiredNodeId) => getNodeName(playerState.tree, requiredNodeId)));
        } else {
            missingAnyRequires.push(buildAnyRequirementLabel(playerState.tree, group));
        }
    }

    const missingNarrative = [];
    for (const narrativeFlag of node.narrative_requires || []) {
        if (!playerState.narrativeFlagSet.has(normalizeText(narrativeFlag))) {
            missingNarrative.push(narrativeFlag);
        }
    }

    const missingCustomRequires = [];
    for (const requirementKey of node.custom_requires || []) {
        const result = evaluateCustomRequirement(playerState, requirementKey);
        if (!result.ok) missingCustomRequires.push(result.label);
        else satisfiedRequires.push(result.label);
    }

    const missingPh = Math.max(0, Number(node.cost_ph || 0) - Number(playerState.ph.available || 0));
    const ok = missingPh === 0
        && missingRequires.length === 0
        && missingAnyRequires.length === 0
        && missingNarrative.length === 0
        && missingCustomRequires.length === 0;

    return {
        ok,
        missing_ph: missingPh,
        missing_requires: missingRequires,
        missing_any_requires: missingAnyRequires,
        missing_narrative: missingNarrative,
        missing_custom_requires: missingCustomRequires,
        already_unlocked: false,
        satisfied_requires: unique([...satisfiedRequires, ...satisfiedAnyRequires]),
    };
}

function listNextTrackCandidates(playerState) {
    const candidates = [];
    const seen = new Set();

    for (const track of Object.values(playerState.tree.purchaseTracks)) {
        const node = getNextNodeForBranch(playerState, track.key);
        if (!node || seen.has(node.id)) continue;
        seen.add(node.id);

        candidates.push({
            track,
            node,
            check: canPurchaseNode(playerState, node),
        });
    }

    return candidates;
}

function sortCandidate(a, b) {
    if (a.track.priority !== b.track.priority) return a.track.priority - b.track.priority;
    if (a.node.cost_ph !== b.node.cost_ph) return a.node.cost_ph - b.node.cost_ph;
    return (a.node.stage || a.node.tier || 0) - (b.node.stage || b.node.tier || 0);
}

function getAvailableNodes(playerState) {
    return listNextTrackCandidates(playerState)
        .filter((candidate) => candidate.check.ok)
        .sort(sortCandidate);
}

function getImportantLockedNodes(playerState) {
    return listNextTrackCandidates(playerState)
        .filter((candidate) => !candidate.check.ok && !candidate.check.already_unlocked)
        .sort((a, b) => {
            const weightA = (
                (a.node.type === 'marco' ? 0 : 5)
                + (a.node.type === 'rota' ? -1 : 0)
                + (a.node.type === 'especial' ? 1 : 0)
                + a.check.missing_requires.length
                + a.check.missing_any_requires.length
                + a.check.missing_custom_requires.length
                + a.check.missing_narrative.length
                + (a.check.missing_ph > 0 ? 1 : 0)
            );
            const weightB = (
                (b.node.type === 'marco' ? 0 : 5)
                + (b.node.type === 'rota' ? -1 : 0)
                + (b.node.type === 'especial' ? 1 : 0)
                + b.check.missing_requires.length
                + b.check.missing_any_requires.length
                + b.check.missing_custom_requires.length
                + b.check.missing_narrative.length
                + (b.check.missing_ph > 0 ? 1 : 0)
            );

            if (weightA !== weightB) return weightA - weightB;
            return sortCandidate(a, b);
        });
}

function getLastPurchasedNodes(playerState, maxItems = 3) {
    return playerState.purchaseHistory
        .slice(0, maxItems)
        .map((nodeId) => playerState.tree.nodesById[nodeId])
        .filter(Boolean);
}

function getRouteStatus(playerState, trackKey) {
    const current = getTrackCurrentNode(playerState, trackKey);
    if (current) return { status: 'em progresso', current };

    const next = getNextNodeForBranch(playerState, trackKey);
    if (!next) return { status: 'concluído', current: null };

    const check = canPurchaseNode(playerState, next);
    return {
        status: check.ok ? 'liberado' : 'bloqueado',
        current: null,
        next,
        check,
    };
}

function getNextMilestoneForTrack(playerState, trackKey) {
    const track = playerState.tree.purchaseTracks[trackKey];
    if (!track) return null;

    return track.ids
        .map((nodeId) => playerState.tree.nodesById[nodeId])
        .find((node) => !playerState.unlockedSet.has(node.id) && node.type !== 'atributo') || null;
}

async function updateLastProxOptions(db, playerId, treeKey, optionIds) {
    await db.run(
        `UPDATE player_skill_trees
         SET last_prox_options = ?, updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ? AND tree = ?`,
        [JSON.stringify(unique(optionIds)), playerId, treeKey]
    );
}

function trimHistory(history, maxItems = 10) {
    return unique(history).slice(0, maxItems);
}

async function purchaseNode(db, playerId, treeKey, nodeId) {
    const stateBefore = await getPlayerSkillState(db, playerId, treeKey);
    if (!stateBefore) return { ok: false, reason: 'player_not_found' };

    const node = stateBefore.tree.nodesById[nodeId];
    const validation = canPurchaseNode(stateBefore, node);
    if (!validation.ok) {
        return {
            ok: false,
            node,
            reason: validation,
            playerState: stateBefore,
        };
    }

    const newUnlocked = unique([...stateBefore.unlockedNodeIds, nodeId]);
    const newSpent = Number(stateBefore.ph.spent || 0) + Number(node.cost_ph || 0);
    const purchaseRecord = {
        nodeId,
        at: new Date().toISOString(),
    };
    const purchaseHistory = trimHistory([nodeId, ...stateBefore.purchaseHistory], 12);

    const beforeAvailable = new Set(getAvailableNodes(stateBefore).map((item) => item.node.id));

    await db.run(
        `UPDATE player_skill_trees
         SET ph_spent = ?, unlocked_node_ids = ?, last_purchase = ?, purchase_history = ?, updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ? AND tree = ?`,
        [
            newSpent,
            JSON.stringify(newUnlocked),
            JSON.stringify(purchaseRecord),
            JSON.stringify(purchaseHistory),
            playerId,
            treeKey,
        ]
    );

    const stateAfter = await getPlayerSkillState(db, playerId, treeKey);
    const afterAvailable = getAvailableNodes(stateAfter);
    const newlyAvailable = afterAvailable.filter((item) => !beforeAvailable.has(item.node.id) && item.node.id !== nodeId);

    return {
        ok: true,
        node,
        stateBefore,
        stateAfter,
        newlyAvailable,
        lastPurchase: purchaseRecord,
    };
}

module.exports = {
    normalizeText,
    getPlayerSkillState,
    getNodeByAlias,
    getNextNodeForBranch,
    canPurchaseNode,
    purchaseNode,
    getAvailableNodes,
    getImportantLockedNodes,
    getTrackCurrentNode,
    getTrackSpentPh,
    getSectionSpentPh,
    getRouteStatus,
    getLastPurchasedNodes,
    getNextMilestoneForTrack,
    updateLastProxOptions,
};
