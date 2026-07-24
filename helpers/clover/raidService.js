'use strict';

const service = require('./raidTraitAwareService');

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

async function createRaid(db, actorId, input = {}) {
    assertOfficialCreationCategory(input);
    return service.createRaid(db, actorId, input);
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
    createRaid,
    getPlayerRaidChecklist,
    normalizeChecklistOptions,
    normalizeRemovalReason,
    removeRaidParticipant,
};
