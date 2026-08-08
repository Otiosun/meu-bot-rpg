'use strict';

const base = require('./adminCommandCenterService');
const { getSpellReviewFlowState } = require('./spellReviewFlowService');
const { getSpellCapacity } = require('./spellCapacityService');

const PRIORITY_WEIGHT = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });

function boundedInteger(value, fallback = 20, maximum = 100) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(maximum, Math.trunc(parsed)));
}

function timestampValue(value) {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : 0;
}

function compareItems(left, right) {
    return (PRIORITY_WEIGHT[left.priority] ?? 9) - (PRIORITY_WEIGHT[right.priority] ?? 9)
        || timestampValue(right.updatedAt) - timestampValue(left.updatedAt)
        || String(left.id).localeCompare(String(right.id));
}

function characterName(entry) {
    return String(entry.personagem_nome || entry.display_name || entry.nome || 'Personagem sem nome').trim();
}

function spellReviewPriority(entry, spellCapacity) {
    if (entry.integrity?.blocking?.length) return 'critical';
    if (entry.status === 'called' && entry.review_state !== 'pending') return 'high';
    if (entry.status === 'called' && entry.review_state === 'pending') return 'medium';
    if (spellCapacity && !spellCapacity.canApproveNewSpell) return 'medium';
    return 'low';
}

function spellReviewSummary(entry, spellCapacity) {
    if (entry.integrity?.blocking?.length) {
        return `Entrada com bloqueio de integridade: ${entry.integrity.blocking.map((item) => item.message).join(' ')}`;
    }
    if (entry.status === 'called' && entry.review_state === 'pending') {
        return entry.hold_reason
            ? `Avaliação suspensa: ${entry.hold_reason}`
            : 'Avaliação suspensa; aguarda retomada, adiamento ou conclusão.';
    }
    if (entry.status === 'called') {
        return 'Personagem chamado e ocupando uma vaga de avaliação; exige revisão administrativa.';
    }
    if (spellCapacity && !spellCapacity.canApproveNewSpell) {
        return spellCapacity.overCapacity
            ? `Aguardando, mas o grimório está acima da capacidade em ${spellCapacity.capacityDebt} slot(s).`
            : 'Aguardando, mas não possui slot disponível para um novo feitiço.';
    }
    const warnings = entry.integrity?.warnings || [];
    if (warnings.length) {
        return `Aguardando na fila com aviso: ${warnings.map((item) => item.message).join(' ')}`;
    }
    return `Aguardando na fila${entry.position ? ` · posição ${entry.position}` : ''}.`;
}

async function readSpellReviewItems(db) {
    const state = await getSpellReviewFlowState(db);
    const items = [];
    for (const entry of state.entries || []) {
        let spellCapacity = null;
        if (entry.player_exists_id && entry.player_id) {
            try {
                spellCapacity = await getSpellCapacity(db, entry.player_id);
            } catch {
                spellCapacity = null;
            }
        }
        const name = characterName(entry);
        items.push({
            id: `spell-review:${entry.id}`,
            category: 'spell_review',
            priority: spellReviewPriority(entry, spellCapacity),
            title: `${name} · avaliação de feitiço`,
            summary: spellReviewSummary(entry, spellCapacity),
            status: entry.status === 'called' && entry.review_state === 'pending'
                ? 'held'
                : entry.status,
            reference: name,
            updatedAt: entry.held_at || entry.called_at || entry.requested_at || null,
            actionPath: '/admin/jogadores',
            metadata: {
                characterName: name,
                queuePosition: Number(entry.position || 0) || null,
                reviewState: entry.review_state || 'active',
                occupiesSlot: Boolean(entry.occupies_slot),
                holdReason: entry.hold_reason || null,
                integrity: {
                    ok: Boolean(entry.integrity?.ok),
                    blocking: (entry.integrity?.blocking || []).map((item) => ({
                        code: item.code,
                        message: item.message,
                    })),
                    warnings: (entry.integrity?.warnings || []).map((item) => ({
                        code: item.code,
                        message: item.message,
                    })),
                },
                spellCapacity: spellCapacity ? {
                    totalSlots: Number(spellCapacity.totalSlots || 0),
                    occupiedSlots: Number(spellCapacity.occupiedSlots || 0),
                    availableSlots: Number(spellCapacity.availableSlots || 0),
                    overCapacity: Boolean(spellCapacity.overCapacity),
                    capacityDebt: Number(spellCapacity.capacityDebt || 0),
                    canApproveNewSpell: Boolean(spellCapacity.canApproveNewSpell),
                } : null,
            },
        });
    }
    return {
        state: {
            capacity: Number(state.capacity || 0),
            autoFlow: Boolean(state.autoFlow),
            active: Number(state.active || 0),
            pending: Number(state.pending || 0),
            waiting: Number(state.waiting || 0),
            vacancies: Number(state.vacancies || 0),
        },
        items,
    };
}

function summarize(items, payload, spellReviews) {
    const priorities = { critical: 0, high: 0, medium: 0, low: 0 };
    const categories = {};
    for (const item of items) {
        priorities[item.priority] = Number(priorities[item.priority] || 0) + 1;
        categories[item.category] = Number(categories[item.category] || 0) + 1;
    }
    return {
        ...(payload.summary || {}),
        total: items.length,
        priorities,
        categories,
        recoverableOperations: categories.operation || 0,
        raidRewardProposals: categories.raid_reward_proposal || 0,
        adminRoleChanges: categories.admin_role_change || 0,
        starAnomalies: categories.stars_integrity || 0,
        spellReviews: spellReviews.items.length,
    };
}

async function getAdminCommandCenter(db, options = {}) {
    const limit = boundedInteger(options.limit, 20, 100);
    const payload = await base.getAdminCommandCenter(db, options);
    const spellReviews = await readSpellReviewItems(db);
    const items = [
        ...(payload.items || []),
        ...spellReviews.items,
    ].sort(compareItems).slice(0, limit);

    return {
        ...payload,
        summary: summarize(items, payload, spellReviews),
        items,
        sections: {
            ...(payload.sections || {}),
            spellReviews: spellReviews.items,
            spellReviewFlow: spellReviews.state,
        },
    };
}

module.exports = {
    ...base,
    getAdminCommandCenter,
    readSpellReviewItems,
    spellReviewPriority,
    spellReviewSummary,
};