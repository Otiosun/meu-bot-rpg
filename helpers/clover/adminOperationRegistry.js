'use strict';

const base = require('./adminOperationRegistryBase');
const { createQuickRewardExecutor } = require('./adminQuickRewardService');
const { createRewardExecutorsV2 } = require('./adminRewardServiceV2');
const { createResourceAdjustmentExecutor } = require('./adminResourceAdjustmentService');
const { createTitleExecutors } = require('./titleAdminService');

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
        'resource.adjust': createResourceAdjustmentExecutor(),
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
