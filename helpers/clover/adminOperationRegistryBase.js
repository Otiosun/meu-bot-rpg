'use strict';

const {
    AdminRaidProgressError,
    createRaidProgressExecutors,
} = require('./adminRaidProgressService');
const {
    createHookExecutors,
    getHookTemplate,
    getPlayerHookAssignment,
} = require('./adminHookService');
const { decorateHookExecutors } = require('./adminHookV2Service');
const { hardenHookV2Executors } = require('./adminHookV2Persistence');
const { createItemExecutors } = require('./itemAdminService');
const { createRewardExecutors } = require('./adminRewardService');
const { createTraitExecutors } = require('./adminTraitService');
const { createTraitOverrideExecutors } = require('./adminTraitOverrideService');
const { createPlayerProfileCorrectionExecutors } = require('./adminPlayerProfileCorrectionService');
const { createPlayerStarAdjustmentExecutors } = require('./adminPlayerStarAdjustmentService');

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

async function assertNoLaterRaidProgressEntries(context = {}) {
    const unit = context.unit || {};
    if (unit.actionType !== 'raid.progress.adjust') return;
    const scope = unit.metadata?.scope;
    const entryId = Number(unit.after?.entryId || unit.metadata?.entryId);
    if (!scope || !Number.isInteger(entryId) || entryId <= 0) return;

    const later = await context.db.get(
        `SELECT id, kind, operation_code
         FROM clover_raid_monthly_ledger
         WHERE id > ?
           AND category_key = ? AND month_key = ?
           AND scope_type = ? AND scope_key = ?
         ORDER BY id ASC LIMIT 1`,
        [
            entryId,
            scope.categoryKey,
            scope.monthKey,
            scope.scopeType,
            scope.scopeKey,
        ]
    );
    if (later) {
        throw new AdminRaidProgressError(
            'raid_progress_changed_since_apply',
            'O progresso mensal recebeu outro lançamento depois desta operação e não pode ser desfeito automaticamente.',
            409,
            {
                entryId,
                laterEntryId: Number(later.id),
                laterKind: later.kind,
                laterOperationCode: later.operation_code || null,
            }
        );
    }
}

function adaptRaidUndoContext(executors) {
    return Object.fromEntries(Object.entries(executors).map(([type, executor]) => {
        if (typeof executor.undo !== 'function') return [type, executor];
        const undo = executor.undo;
        return [type, {
            ...executor,
            async undo(context) {
                await assertNoLaterRaidProgressEntries(context);
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

function withCurrentAuditFields(snapshot, current) {
    if (!snapshot || !current) return snapshot;
    return {
        ...snapshot,
        operationCode: current.operationCode,
        updatedBy: current.updatedBy,
        updatedAt: current.updatedAt,
    };
}

function adaptHookUndoContext(executors) {
    return Object.fromEntries(Object.entries(executors).map(([type, executor]) => {
        if (typeof executor.undo !== 'function') return [type, executor];
        const undo = executor.undo;
        return [type, {
            ...executor,
            async undo(context) {
                let after = context.after || context.unit?.after || {};
                if (type.startsWith('player.hook.') && after?.id) {
                    const current = await getPlayerHookAssignment(
                        context.db,
                        after.id,
                        { nullIfMissing: true }
                    );
                    after = withCurrentAuditFields(after, current);
                } else if (type.startsWith('catalog.hook.') && after?.id) {
                    const current = await getHookTemplate(
                        context.db,
                        after.id,
                        { nullIfMissing: true }
                    );
                    after = withCurrentAuditFields(after, current);
                }
                return undo({ ...context, after });
            },
        }];
    }));
}

function createUniversalHookExecutors() {
    return hardenHookV2Executors(decorateHookExecutors(createHookExecutors()));
}

function getAdminOperationExecutors() {
    return {
        ...createTraitExecutors(),
        ...createItemExecutors(),
        ...adaptHookUndoContext(createUniversalHookExecutors()),
        ...createRewardExecutors(),
        ...createTraitOverrideExecutors(),
        ...createPlayerProfileCorrectionExecutors(),
        ...createPlayerStarAdjustmentExecutors(),
        ...adaptRaidUndoContext(createRaidProgressExecutors()),
    };
}

module.exports = {
    adaptHookUndoContext,
    adaptRaidUndoContext,
    assertNoLaterRaidProgressEntries,
    createUniversalHookExecutors,
    getAdminOperationExecutors,
    persistedTarget,
    withCurrentAuditFields,
};
