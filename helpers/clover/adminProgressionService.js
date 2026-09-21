'use strict';

const {
    ATTRIBUTE_KEYS,
    ensureCharacterStats,
    getAttributeValues,
    getCharacterStats,
    getPbUsage,
} = require('./characterStats');
const { getPendingPurchase, getTreeState } = require('./skillTreeService');
const { listTrees } = require('./treeLoader');

class AdminProgressionError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminProgressionError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function valuesMatch(left, right) {
    return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function safeJson(value, fallback = null) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return fallback; }
}

function deriveAllocatedAttributes(stats = {}) {
    const effective = getAttributeValues(stats);
    const nonPm = Number(effective.forca || 0)
        + Number(effective.velocidade || 0)
        + Number(effective.agilidade || 0)
        + Number(effective.resistencia || 0);
    const storedSpent = Math.max(0, Number(stats.pb_spent || 0));
    let allocatedPm = storedSpent - nonPm;
    if (!Number.isFinite(allocatedPm) || allocatedPm < 0) {
        allocatedPm = Number(effective.poder_magico || 0);
    }
    const allocated = {
        ...effective,
        poder_magico: Math.max(0, Math.trunc(allocatedPm)),
    };
    const effectivePm = Number(effective.poder_magico || 0);
    return {
        allocated,
        effective,
        pmExternalDelta: effectivePm - allocated.poder_magico,
    };
}

function progressionSnapshot(stats) {
    const allocation = deriveAllocatedAttributes(stats);
    const pbTotal = Math.max(0, Number(stats.pb_total || 0));
    const pbSpent = ATTRIBUTE_KEYS.reduce((sum, key) => sum + Number(allocation.allocated[key] || 0), 0);
    const pending = safeJson(stats.pending_distribution_json, null);
    return {
        playerId: stats.player_id,
        stageKey: stats.stage_key,
        pbTotal,
        pbSpent,
        pbFree: Math.max(0, pbTotal - pbSpent),
        distributionStatus: stats.distribution_status || 'pending',
        allocatedAttributes: allocation.allocated,
        effectiveAttributes: allocation.effective,
        pmExternalDelta: allocation.pmExternalDelta,
        pendingDistribution: pending,
        confirmedAt: stats.confirmed_at || null,
        updatedAt: stats.updated_at || null,
    };
}

async function readPlayerProgression(db, playerId, options = {}) {
    const stats = await ensureCharacterStats(db, playerId);
    const snapshot = progressionSnapshot(stats);
    const includeTrees = options.includeTrees !== false;
    const treeStates = [];
    if (includeTrees) {
        for (const tree of listTrees()) {
            const state = await getTreeState(db, playerId, tree.id);
            treeStates.push({
                id: tree.id,
                name: tree.name,
                subtitle: tree.subtitle || null,
                phAvailable: Number(state?.ph?.phAvailable ?? state?.ph?.disponivel ?? 0),
                discountPercent: Number(state?.discount?.percent || 0),
                ownedIds: Array.isArray(state?.ownedIds) ? state.ownedIds : [],
                ownedCount: Number(state?.ownedCount || 0),
                totalNodes: Number(state?.totalNodes || tree.nodes?.length || 0),
                nodeStates: Array.isArray(state?.nodeStates) ? state.nodeStates : [],
            });
        }
    }
    const pendingPurchase = await getPendingPurchase(db, playerId).catch(() => null);
    return {
        ok: true,
        progression: snapshot,
        trees: treeStates,
        pendingPurchase,
        approvalQueue: {
            available: false,
            status: 'live_hotfix_required',
            note: 'Pedidos de nós com aprovação dependem do hotfix sistêmico vivo e serão reconciliados antes do deploy.',
        },
    };
}

function normalizeFinalAllocation(payload, before) {
    const source = payload?.attributes || payload?.atributos || payload?.values || payload || {};
    const values = {};
    for (const key of ATTRIBUTE_KEYS) {
        const raw = source[key];
        if (raw === undefined || raw === null || raw === '') {
            throw new AdminProgressionError('missing_attribute_value', `Informe o valor final de ${key}.`, 400, { key });
        }
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1) {
            throw new AdminProgressionError('invalid_attribute_value', `${key} precisa ser um inteiro de pelo menos 1 PB.`, 400, { key, value: raw });
        }
        values[key] = value;
    }
    const used = ATTRIBUTE_KEYS.reduce((sum, key) => sum + values[key], 0);
    const pbTotal = Number(before.pbTotal || 0);
    const maxPerAttribute = Math.floor(pbTotal / 2);
    if (used > pbTotal) {
        throw new AdminProgressionError('attribute_budget_exceeded', `A distribuição usa ${used} PB, mas o total é ${pbTotal}.`, 409, { used, pbTotal });
    }
    for (const key of ATTRIBUTE_KEYS) {
        if (values[key] > maxPerAttribute) {
            throw new AdminProgressionError('attribute_limit_exceeded', `${key} não pode passar de ${maxPerAttribute} PB neste estágio.`, 409, {
                key,
                value: values[key],
                maxPerAttribute,
            });
        }
    }
    return { values, used, pbTotal, free: pbTotal - used, maxPerAttribute };
}

function comparableProgression(snapshot) {
    if (!snapshot) return snapshot;
    const { updatedAt, ...stable } = snapshot;
    return stable;
}

async function assertProgressionUnchanged(db, playerId, expected) {
    const current = progressionSnapshot(await getCharacterStats(db, playerId));
    if (!valuesMatch(comparableProgression(current), comparableProgression(expected))) {
        throw new AdminProgressionError(
            'progression_changed_after_preview',
            'Os atributos/PB mudaram depois da prévia. Gere uma nova prévia.',
            409,
            { playerId }
        );
    }
    return current;
}

async function applyAllocationSnapshot(db, snapshot, options = {}) {
    const allocated = snapshot.allocatedAttributes;
    const effectivePm = Number(allocated.poder_magico || 0) + Number(snapshot.pmExternalDelta || 0);
    if (effectivePm < 0) {
        throw new AdminProgressionError('effective_pm_below_zero', 'A correção deixaria o Poder Mágico efetivo abaixo de zero.', 409, {
            allocatedPm: allocated.poder_magico,
            externalDelta: snapshot.pmExternalDelta,
        });
    }
    await db.run(
        `UPDATE clover_character_stats
         SET forca = ?, velocidade = ?, agilidade = ?, resistencia = ?, poder_magico = ?,
             pb_spent = ?, distribution_status = ?, pending_distribution_json = ?,
             confirmed_at = ?, updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ?`,
        [
            allocated.forca,
            allocated.velocidade,
            allocated.agilidade,
            allocated.resistencia,
            effectivePm,
            snapshot.pbSpent,
            snapshot.distributionStatus,
            snapshot.pendingDistribution ? JSON.stringify(snapshot.pendingDistribution) : null,
            snapshot.confirmedAt,
            snapshot.playerId,
        ]
    );
    if (options.clearPending) {
        await db.run(
            `UPDATE clover_character_stats
             SET pending_distribution_json = NULL, distribution_status = 'confirmed',
                 confirmed_at = COALESCE(confirmed_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
             WHERE player_id = ?`,
            [snapshot.playerId]
        );
    }
}

function createProgressionExecutors() {
    return {
        'player.attributes.correct': {
            async preview({ db, action, target }) {
                const stats = await ensureCharacterStats(db, target.playerId);
                const before = progressionSnapshot(stats);
                const clearPending = Boolean(action.payload?.clearPending || action.payload?.clear_pending);
                if (before.distributionStatus === 'pending_confirmation' && !clearPending) {
                    throw new AdminProgressionError(
                        'attribute_distribution_pending',
                        'Existe uma distribuição de atributos pendente. Cancele-a explicitamente nesta correção.',
                        409,
                        { pendingDistribution: before.pendingDistribution }
                    );
                }
                const normalized = normalizeFinalAllocation(action.payload || {}, before);
                const after = {
                    ...before,
                    pbSpent: normalized.used,
                    pbFree: normalized.free,
                    allocatedAttributes: normalized.values,
                    effectiveAttributes: {
                        ...normalized.values,
                        poder_magico: normalized.values.poder_magico + before.pmExternalDelta,
                    },
                    distributionStatus: 'confirmed',
                    pendingDistribution: null,
                    confirmedAt: before.confirmedAt || new Date().toISOString(),
                };
                if (after.effectiveAttributes.poder_magico < 0) {
                    throw new AdminProgressionError('effective_pm_below_zero', 'A correção deixaria o Poder Mágico efetivo abaixo de zero.', 409);
                }
                return {
                    summary: `${target.characterName || target.playerId}: corrigir distribuição de PB`,
                    before,
                    after,
                };
            },
            async apply({ db, target, before, after }) {
                await assertProgressionUnchanged(db, target.playerId, before);
                await applyAllocationSnapshot(db, after, { clearPending: true });
                return {
                    after: progressionSnapshot(await getCharacterStats(db, target.playerId)),
                    summary: `${target.characterName || target.playerId}: distribuição de PB corrigida.`,
                };
            },
            async undo({ db, target, before, after }) {
                await assertProgressionUnchanged(db, target.playerId, after);
                await applyAllocationSnapshot(db, before);
            },
        },
    };
}

module.exports = {
    AdminProgressionError,
    createProgressionExecutors,
    deriveAllocatedAttributes,
    normalizeFinalAllocation,
    progressionSnapshot,
    readPlayerProgression,
};
