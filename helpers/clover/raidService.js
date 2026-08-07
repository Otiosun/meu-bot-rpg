'use strict';

const service = require('./raidTraitAwareService');
const {
    createRaidWithPersistentIdempotency,
} = require('./raidCreationIdempotency');

function assertOfficialCreationCategory(input = {}) {
    const rawCategory = String(input.category || input.categoria || '').trim();
    if (/[?�]/.test(rawCategory)) {
        throw new service.RaidServiceError(
            'invalid_raid_category',
            'Escolha uma categoria oficial de Raid.',
            { categories: service.getRaidCategoryCatalog() }
        );
    }
}

function normalizeChecklistOptions(options = {}) {
    const rawMonthKey = options.monthKey ?? options.month_key ?? null;
    if (rawMonthKey === null || rawMonthKey === undefined || rawMonthKey === '') return {};
    const monthKey = String(rawMonthKey).trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
        throw new service.RaidServiceError(
            'invalid_month_key',
            'Mês inválido. Use YYYY-MM.',
            { monthKey }
        );
    }
    return { monthKey };
}

function normalizeRemovalReason(value) {
    const reason = String(value || '').trim().replace(/\s+/g, ' ');
    if (reason.length < 3) {
        throw new service.RaidServiceError(
            'removal_reason_required',
            'Informe o motivo da remoção do participante.',
            { minimumLength: 3 }
        );
    }
    return reason.slice(0, 500);
}

function enforceEligibleParticipant(summary) {
    if (!summary || summary.raid?.status === 'completed') return summary;
    const pending = Number(summary.counts?.pending || 0);
    const eligible = Number(summary.counts?.eligible || 0);

    // Enquanto a revisão estiver pendente, essa é a única trava relevante.
    // Zero elegíveis só é um diagnóstico válido depois de todos serem revisados.
    if (pending > 0 || eligible > 0) return summary;

    const warnings = Array.isArray(summary.warnings) ? [...summary.warnings] : [];
    if (!warnings.some((warning) => warning.code === 'raid_without_eligible_participants')) {
        warnings.push({
            code: 'raid_without_eligible_participants',
            message: 'Marque ao menos um participante como elegível antes de concluir.',
        });
    }
    return {
        ...summary,
        warnings,
        canComplete: false,
    };
}

async function createRaid(db, actorId, input = {}) {
    assertOfficialCreationCategory(input);
    return createRaidWithPersistentIdempotency(db, actorId, input, {
        errorFactory: (code, message, details = {}) => (
            new service.RaidServiceError(code, message, details)
        ),
        execute: (preparedInput) => service.createRaid(db, actorId, preparedInput),
        recover: async (raidKey) => {
            const dashboard = await service.getRaidDashboard(db, raidKey, actorId);
            return {
                ok: true,
                raid: dashboard.raid,
                role: 'owner',
                principal: true,
            };
        },
    });
}

async function getPlayerRaidChecklist(db, playerId, options = {}) {
    const checklist = await service.getPlayerRaidChecklist(
        db,
        playerId,
        normalizeChecklistOptions(options)
    );
    const { playerId: _privatePlayerId, ...publicChecklist } = checklist;
    return publicChecklist;
}

async function getRaidFinalizationSummary(db, raidKey, actorId) {
    return enforceEligibleParticipant(
        await service.getRaidFinalizationSummary(db, raidKey, actorId)
    );
}

async function getRaidDashboard(db, raidKey, actorId) {
    const dashboard = await service.getRaidDashboard(db, raidKey, actorId);
    return dashboard?.finalization
        ? { ...dashboard, finalization: enforceEligibleParticipant(dashboard.finalization) }
        : dashboard;
}

async function completeRaid(db, raidKey, actorId, options = {}) {
    const summary = await getRaidFinalizationSummary(db, raidKey, actorId);
    const pending = Number(summary.counts?.pending || 0);
    const eligible = Number(summary.counts?.eligible || 0);

    // A revisão pendente é a primeira trava. O erro de zero elegíveis só faz
    // sentido depois que o host classificou todos os participantes.
    if (summary.raid?.status !== 'completed' && pending === 0 && eligible === 0) {
        throw new service.RaidServiceError(
            'raid_without_eligible_participants',
            'Marque ao menos um participante como elegível antes de concluir a raid.'
        );
    }
    return service.completeRaid(db, raidKey, actorId, options);
}

async function completeRaidForRewardProposal(db, raidKey, actorId, options = {}) {
    const summary = await getRaidFinalizationSummary(db, raidKey, actorId);
    const pending = Number(summary.counts?.pending || 0);
    const eligible = Number(summary.counts?.eligible || 0);

    if (summary.raid?.status !== 'completed' && pending === 0 && eligible === 0) {
        throw new service.RaidServiceError(
            'raid_without_eligible_participants',
            'Marque ao menos um participante como elegivel antes de concluir a raid.'
        );
    }
    return service.completeRaidForRewardProposal(db, raidKey, actorId, options);
}

async function removeRaidParticipant(db, raidKey, actorId, targetPlayerId, reason) {
    return service.removeRaidParticipant(
        db,
        raidKey,
        actorId,
        targetPlayerId,
        normalizeRemovalReason(reason)
    );
}

module.exports = {
    ...service,
    assertOfficialCreationCategory,
    completeRaid,
    completeRaidForRewardProposal,
    createRaid,
    enforceEligibleParticipant,
    getPlayerRaidChecklist,
    getRaidDashboard,
    getRaidFinalizationSummary,
    normalizeChecklistOptions,
    normalizeRemovalReason,
    removeRaidParticipant,
};
