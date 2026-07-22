'use strict';

function finiteRequirement(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

function buildStageProgress(stage, nextStage, phAccumulated = 0) {
    const accumulated = Math.max(0, Number(phAccumulated || 0));
    const stageKey = String(stage?.key || '9');
    const currentRequired = finiteRequirement(stage?.ph_required) ?? 0;
    const nextRequired = finiteRequirement(nextStage?.ph_required);
    const automatic = stage?.automatic !== false && stageKey !== 'arcano';

    if (!automatic) {
        return {
            mode: 'special',
            automatic: false,
            stageKey,
            currentRequired: finiteRequirement(stage?.ph_required),
            nextRequired: null,
            current: null,
            total: null,
            percentage: null,
            missing: null,
            thresholdReached: false,
        };
    }

    if (!nextStage || nextRequired === null) {
        return {
            mode: 'terminal',
            automatic: true,
            stageKey,
            currentRequired,
            nextRequired: null,
            current: Math.max(0, accumulated - currentRequired),
            total: null,
            percentage: 100,
            missing: null,
            thresholdReached: true,
        };
    }

    const total = Math.max(1, nextRequired - currentRequired);
    const current = Math.min(total, Math.max(0, accumulated - currentRequired));
    const missing = Math.max(0, nextRequired - accumulated);

    return {
        mode: 'automatic',
        automatic: true,
        stageKey,
        currentRequired,
        nextRequired,
        current,
        total,
        percentage: Math.min(100, Math.max(0, Math.round((current / total) * 100))),
        missing,
        thresholdReached: missing === 0,
    };
}

module.exports = {
    buildStageProgress,
};
