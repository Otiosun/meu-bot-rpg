'use strict';

const {
    createInventoryInstanceExecutors,
} = require('./adminInventoryInstanceService');

function withoutAuditFields(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
    const { historyId, ...rest } = snapshot;
    return rest;
}

function createInventoryInstanceExecutorsForRegistry() {
    const executors = createInventoryInstanceExecutors();
    const update = executors['player.item.update'];
    if (update?.undo) {
        const undo = update.undo;
        executors['player.item.update'] = {
            ...update,
            async undo(context) {
                return undo({
                    ...context,
                    after: withoutAuditFields(context.after || context.unit?.after),
                });
            },
        };
    }
    return executors;
}

module.exports = {
    createInventoryInstanceExecutorsForRegistry,
    withoutAuditFields,
};
