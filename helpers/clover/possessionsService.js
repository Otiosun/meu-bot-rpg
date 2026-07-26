'use strict';

const { getBoxHistory } = require('./boxService');
const { getStructuredInventory } = require('./inventoryService');
const { decorateItemUse } = require('./itemUseCatalog');
const { listOwnItemRedemptions } = require('./itemRedemptionService');
const {
    getActivePlayerTitle,
    listPlayerTitleHistory,
    listPlayerTitles,
} = require('./titleService');

function specialCategory(item = {}) {
    if (item.useAction) return 'usable';
    if (item.category === 'caixa') return 'box';
    if (item.category === 'reliquia') return 'relic';
    if (item.category === 'titulo') return 'title';
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

    const [inventory, titles, activeTitle, titleHistory, redemptions, boxHistory] =
        await Promise.all([
            getStructuredInventory(db, playerId, { limit: inventoryLimit }),
            listPlayerTitles(db, playerId),
            getActivePlayerTitle(db, playerId),
            listPlayerTitleHistory(db, playerId, historyLimit),
            listOwnItemRedemptions(db, playerId, historyLimit),
            getBoxHistory(db, playerId, historyLimit),
        ]);

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
            titleCount: titles.length,
            hasActiveTitle: Boolean(activeTitle),
            pendingRedemptions: pendingRedemptions.length,
            boxOpenings: boxHistory.length,
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
        spellCapacity: {
            status: 'not_consolidated',
            baseSlots: null,
            additionalSlots: null,
            occupiedSlots: null,
            reservedSlots: null,
            availableSlots: null,
            message: 'Capacidade pessoal de feitiços ainda não consolidada.',
            reviewQueueIsNotPersonalCapacity: true,
        },
    };
}

module.exports = {
    getPlayerPossessions,
    specialCategory,
};
