'use strict';

const { getBoxHistory } = require('./boxService');
const { getStructuredInventory } = require('./inventoryService');
const { decorateItemUse } = require('./itemUseCatalog');
const { listOwnItemRedemptions } = require('./itemRedemptionService');
const { getSpellCapacity } = require('./spellCapacityService');
const {
    getActivePlayerTitle,
    listPlayerTitleHistory,
    listPlayerTitles,
} = require('./titleService');

function specialCategory(item = {}) {
    const actionKey = item.useAction?.actionKey || null;
    if (actionKey === 'use_spell_ticket' || item.kind === 'ticket_feitico') return 'ticket';
    if (item.category === 'caixa') return 'box';
    if (item.category === 'titulo') return 'title';
    if (item.category === 'reliquia') return 'relic';
    if (item.category === 'missao' || String(item.kind || '').startsWith('acesso_')) return 'access';
    if (String(item.kind || '').startsWith('cupom_') || String(item.kind || '').startsWith('vale_')) return 'coupon';
    if (item.useAction) return 'usable';
    return 'other';
}

async function getPlayerPossessions(db, playerId, options = {}) {
    const inventoryLimit = Math.max(
        1,
        Math.min(300, Number(options.inventoryLimit) || 200)
    );
    const historyLimit = Math.max(
        1,
        Math.min(100, Number(options.historyLimit) || 20)
    );

    // Estes serviços executam inicializações idempotentes de schema. Na mesma
    // conexão SQLite, a leitura sequencial evita corridas entre CREATE INDEX,
    // backfill e consultas do primeiro acesso.
    const inventory = await getStructuredInventory(
        db,
        playerId,
        { limit: inventoryLimit }
    );
    const titles = await listPlayerTitles(db, playerId);
    const activeTitle = await getActivePlayerTitle(db, playerId);
    const titleHistory = await listPlayerTitleHistory(
        db,
        playerId,
        historyLimit
    );
    const redemptions = await listOwnItemRedemptions(
        db,
        playerId,
        historyLimit
    );
    const boxHistory = await getBoxHistory(
        db,
        playerId,
        historyLimit
    );
    const spellCapacity = await getSpellCapacity(db, playerId);

    const decoratedInventory = inventory.map(decorateItemUse);
    const specialItems = decoratedInventory
        .filter((item) => (
            item.useAction
            || ['caixa', 'reliquia', 'titulo', 'missao'].includes(item.category)
        ))
        .map((item) => ({
            ...item,
            possessionCategory: specialCategory(item),
        }));

    const pendingRedemptions = redemptions.filter(
        (redemption) => redemption.status === 'pending'
    );
    const countCategory = (category) => specialItems.filter(
        (item) => item.possessionCategory === category
    ).length;

    return {
        available: true,
        status: 'ready',
        summary: {
            inventoryRows: decoratedInventory.length,
            inventoryUnits: decoratedInventory.reduce(
                (sum, item) => sum + Number(item.quantity || 0),
                0
            ),
            specialItemRows: specialItems.length,
            usableItemRows: specialItems.filter((item) => item.useAction).length,
            ticketItemRows: countCategory('ticket'),
            couponItemRows: countCategory('coupon'),
            boxItemRows: countCategory('box'),
            accessItemRows: countCategory('access'),
            relicItemRows: countCategory('relic'),
            titleCount: titles.length,
            hasActiveTitle: Boolean(activeTitle),
            pendingRedemptions: pendingRedemptions.length,
            boxOpenings: boxHistory.length,
            spellSlotsTotal: spellCapacity.totalSlots,
            spellSlotsOccupied: spellCapacity.occupiedSlots,
            spellSlotsAvailable: spellCapacity.availableSlots,
        },
        titles: {
            active: activeTitle,
            owned: titles,
            history: titleHistory,
            allowsNone: true,
            activePolicy: 'zero_or_one',
        },
        items: {
            special: specialItems,
            all: decoratedInventory,
        },
        redemptions: {
            pending: pendingRedemptions,
            history: redemptions,
            itemReservationPolicy: 'reserve_until_resolution',
            rejectedOrCancelledPolicy: 'release_item',
        },
        boxes: {
            recentOpenings: boxHistory,
            latestOpening: boxHistory[0] || null,
            recoveryPolicy: 'history_by_authenticated_player',
        },
        spellCapacity,
    };
}

module.exports = {
    getPlayerPossessions,
    specialCategory,
};
