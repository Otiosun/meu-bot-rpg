'use strict';

const { createRaidProgressExecutors } = require('./adminRaidProgressService');
const { createTraitExecutors } = require('./adminTraitService');

function persistedTarget(unit = {}) {
    const stored = unit.metadata?.target || {};
    return {
        playerId: unit.target_player_id || stored.playerId || null,
        characterName: stored.characterName || null,
        displayName: stored.displayName || null,
        squad: stored.squad || null,
        gameStatus: stored.gameStatus || null,
    };
}

function adaptRaidUndoContext(executors) {
    return Object.fromEntries(Object.entries(executors).map(([type, executor]) => {
        if (typeof executor.undo !== 'function') return [type, executor];
        const undo = executor.undo;
        return [type, {
            ...executor,
            undo(context) {
                return undo({
                    ...context,
                    before: context.unit?.before || {},
                    after: context.unit?.after || {},
                    target: persistedTarget(context.unit),
                });
            },
        }];
    }));
}

function getAdminOperationExecutors() {
    return {
        ...createTraitExecutors(),
        ...adaptRaidUndoContext(createRaidProgressExecutors()),
    };
}

module.exports = {
    adaptRaidUndoContext,
    getAdminOperationExecutors,
    persistedTarget,
};