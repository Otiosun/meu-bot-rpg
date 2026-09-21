'use strict';

const base = require('./adminOperationRegistryBase');
const { createTitleExecutors } = require('./titleAdminService');
const { createSpellExecutorsForRegistry } = require('./adminSpellExecutorAdapter');
const { createSpellReviewExecutors } = require('./adminSpellReviewService');
const { createSystemSpellReviewExecutors } = require('./adminSystemSpellReviewService');
const { createResourceAdjustmentExecutor } = require('./adminResourceAdjustmentService');

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
    return markAtomicSafety({
        ...base.getAdminOperationExecutors(),
        ...createTitleExecutors(),
        ...createSpellExecutorsForRegistry(),
        ...createSpellReviewExecutors(),
        ...createSystemSpellReviewExecutors(),
        'resource.adjust': createResourceAdjustmentExecutor(),
    });
}

module.exports = {
    ...base,
    ATOMIC_SAFE_ACTION_TYPES,
    getAdminOperationExecutors,
    markAtomicSafety,
};
