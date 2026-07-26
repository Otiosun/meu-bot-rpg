'use strict';

const { ensureCloverEconomySchema } = require('../../database');
const {
    ensureSpellbookSchema,
    getActiveQueueEntry,
    getQueuePosition,
    listApprovedSpells,
} = require('./spellbookService');

const BASE_SPELL_SLOTS = 1;

async function countDirectTicketUses(db, playerId) {
    const row = await db.get(
        `SELECT COUNT(*) AS total
         FROM clover_consumable_uses
         WHERE player_id = ?
           AND template_key = 'ticket_feitico'
           AND result = 'used'`,
        [playerId]
    );
    return Math.max(0, Number(row?.total || 0));
}

async function countLegacyApprovedTicketUses(db, playerId) {
    const row = await db.get(
        `SELECT COUNT(*) AS total
         FROM clover_item_redemptions
         WHERE player_id = ?
           AND template_key = 'ticket_feitico'
           AND status = 'approved'`,
        [playerId]
    );
    return Math.max(0, Number(row?.total || 0));
}

async function getSpellCapacity(db, playerId) {
    await ensureCloverEconomySchema(db);
    await ensureSpellbookSchema(db);

    const [directTicketUses, legacyApprovedTicketUses, spells, queueEntry] = await Promise.all([
        countDirectTicketUses(db, playerId),
        countLegacyApprovedTicketUses(db, playerId),
        listApprovedSpells(db, playerId),
        getActiveQueueEntry(db, playerId),
    ]);

    const queuePosition = queueEntry ? await getQueuePosition(db, queueEntry) : null;
    const additionalSlots = directTicketUses + legacyApprovedTicketUses;
    const totalSlots = BASE_SPELL_SLOTS + additionalSlots;
    const occupiedSlots = spells.length;
    const capacityDebt = Math.max(0, occupiedSlots - totalSlots);
    const availableSlots = Math.max(0, totalSlots - occupiedSlots);
    const overCapacity = capacityDebt > 0;

    return {
        status: 'ready',
        baseSlots: BASE_SPELL_SLOTS,
        additionalSlots,
        totalSlots,
        occupiedSlots,
        reservedSlots: 0,
        availableSlots,
        overCapacity,
        capacityDebt,
        regularizationTicketsNeeded: capacityDebt,
        regularizationState: overCapacity ? 'legacy_over_capacity' : 'regular',
        preservesApprovedSpells: true,
        canApproveNewSpell: availableSlots > 0,
        sourceBreakdown: {
            directTicketUses,
            legacyApprovedTicketUses,
        },
        reviewQueue: queueEntry ? {
            status: queueEntry.status,
            requestedAt: queueEntry.requested_at,
            calledAt: queueEntry.called_at,
            position: queuePosition,
        } : null,
        reviewQueueIsNotPersonalCapacity: true,
        message: availableSlots > 0
            ? `${availableSlots} slot(s) disponível(is).`
            : overCapacity
                ? `Excesso legado de ${capacityDebt} slot(s). Feitiços aprovados foram preservados; novos feitiços ficam bloqueados até a regularização.`
                : 'Todos os slots estão ocupados.',
    };
}

module.exports = {
    BASE_SPELL_SLOTS,
    countDirectTicketUses,
    countLegacyApprovedTicketUses,
    getSpellCapacity,
};