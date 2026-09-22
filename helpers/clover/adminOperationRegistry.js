'use strict';

const base = require('./adminOperationRegistryBase');
const { createTitleExecutors } = require('./titleAdminService');
const { createSpellExecutorsForRegistry } = require('./adminSpellExecutorAdapter');
const { createSpellReviewExecutors } = require('./adminSpellReviewService');
const { createSystemSpellReviewExecutors } = require('./adminSystemSpellReviewService');
const { createResourceAdjustmentExecutor } = require('./adminResourceAdjustmentService');
const { createProgressionExecutors } = require('./adminProgressionService');
const { createInventoryInstanceExecutorsForRegistry } = require('./adminInventoryInstanceExecutorAdapter');
const { createAdminBoxPityExecutors } = require('./adminBoxPityService');
const { createBoxCatalogVersionExecutors } = require('./adminBoxCatalogVersionService');
const { createSkillTreeCatalogExecutors } = require('./adminSkillTreeCatalogOperationService');
const { createShopCatalogVersionExecutors } = require('./adminShopCatalogVersionService');
const { createMissionExecutors } = require('./adminMissionService');
const { createAdminMarketExecutors } = require('./adminMarketService');
const { createAdminDreamWorldExecutors } = require('./adminDreamWorldOperationService');
const { createQuickRewardExecutor } = require('./adminQuickRewardService');
const { createRewardExecutorsV2 } = require('./adminRewardServiceV2');

const ATOMIC_SAFE_ACTION_TYPES = Object.freeze(new Set([
    'catalog.trait.update',
    'catalog.trait.archive',
    'catalog.trait.restore',
    'player.trait.assign',
    'player.trait.remove',
    'catalog.item.create',
    'catalog.item.update',
    'catalog.item.archive',
    'catalog.item.restore',
    'player.item.grant',
    'player.trait.customize',
    'player.trait.reset_override',
    'raid.progress.adjust',
    'raid.reservation.release',
]));

function markAtomicSafety(registry) {
    return Object.fromEntries(Object.entries(registry || {}).map(([type, executor]) => [
        type,
        {
            ...executor,
            atomicSafe: ATOMIC_SAFE_ACTION_TYPES.has(type),
        },
    ]));
}

function getAdminOperationExecutors() {
    const registry = {
        ...base.getAdminOperationExecutors(),
        ...createRewardExecutorsV2(),
        ...createTitleExecutors(),
        ...createSpellExecutorsForRegistry(),
        ...createSpellReviewExecutors(),
        ...createSystemSpellReviewExecutors(),
        'resource.adjust': createResourceAdjustmentExecutor(),
        ...createProgressionExecutors(),
        ...createInventoryInstanceExecutorsForRegistry(),
        ...createAdminBoxPityExecutors(),
        ...createBoxCatalogVersionExecutors(),
        ...createSkillTreeCatalogExecutors(),
        ...createShopCatalogVersionExecutors(),
        ...createMissionExecutors(),
        ...createAdminMarketExecutors(),
        ...createAdminDreamWorldExecutors(),
    };
    registry['reward.grant'] = createQuickRewardExecutor(registry['reward.grant']);
    return markAtomicSafety(registry);
}

module.exports = {
    ...base,
    ATOMIC_SAFE_ACTION_TYPES,
    getAdminOperationExecutors,
    markAtomicSafety,
};
