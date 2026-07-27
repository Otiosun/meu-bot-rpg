'use strict';

const {
    patchFile,
    run: applyBaseIntegration,
} = require('./applyBoxPityIntegrationPatch');

function applySafetyPatches() {
    patchFile('helpers/clover/boxService.js', [
        {
            label: 'fallback de Relíquia respeita antirrepetição',
            before: `    const fallbackWeights = Array.isArray(options.relicFallbackWeights)
        ? options.relicFallbackWeights.filter((entry) => entry.reward.pityTier === 'high_non_relic' && entry.units > 0)
        : [];
    const fallback = selectWeightedWithScale(fallbackWeights, randomInt)
        || selectWeightedReward(
            box.rewards.filter((reward) => reward.pityTier === 'high_non_relic'),
            randomInt
        );
    return {
        reward: fallback,
        relicKey: null,
        rerolledFrom: selectedReward.key,
        relicPoolEmpty: true,
    };`,
            after: `    const fallbackWeights = Array.isArray(options.relicFallbackWeights)
        ? options.relicFallbackWeights.filter((entry) => entry.reward.pityTier === 'high_non_relic' && entry.units > 0)
        : [];
    const lastRewardKey = String(options.lastRewardKey || '').trim();
    const fallbackAntiRepeatApplied = Boolean(
        lastRewardKey
        && fallbackWeights.some((entry) => entry.reward.key === lastRewardKey && entry.units > 0)
        && fallbackWeights.some((entry) => entry.reward.key !== lastRewardKey && entry.units > 0)
    );
    const repeatSafeFallbackWeights = filterRepeatWeights(
        fallbackWeights,
        lastRewardKey
    );
    const fallback = selectWeightedWithScale(repeatSafeFallbackWeights, randomInt)
        || selectWeightedReward(
            box.rewards.filter(
                (reward) => reward.pityTier === 'high_non_relic'
                    && reward.key !== lastRewardKey
            ),
            randomInt
        );
    return {
        reward: fallback,
        relicKey: null,
        rerolledFrom: selectedReward.key,
        relicPoolEmpty: true,
        fallbackAntiRepeatApplied,
    };`,
        },
        {
            label: 'passar última recompensa ao fallback de Relíquia',
            before: `                availableRelicKeys,
                relicFallbackWeights: distribution.weights,
            }`,
            after: `                availableRelicKeys,
                relicFallbackWeights: distribution.weights,
                lastRewardKey: pityBefore.lastRewardKey,
            }`,
        },
        {
            label: 'hard pity evita Título já desbloqueado',
            before: `        let originallySelected = initiallySelected;
        let antiRepeatApplied = false;
        if (
            initiallySelected?.key === pityBefore.lastRewardKey
            && initiallySelected?.pityTier !== 'ultra_relic'
        ) {
            const filtered = filterRepeatWeights(
                distribution.weights,
                pityBefore.lastRewardKey
            );
            const rerolled = selectWeightedWithScale(filtered, randomInt);
            if (rerolled && rerolled.key !== initiallySelected.key) {
                originallySelected = rerolled;
                antiRepeatApplied = true;
            }
        }
        const resolved = await resolveRewardInTransaction(`,
            after: `        let originallySelected = initiallySelected;
        let antiRepeatApplied = false;
        if (
            initiallySelected?.key === pityBefore.lastRewardKey
            && initiallySelected?.pityTier !== 'ultra_relic'
        ) {
            const filtered = filterRepeatWeights(
                distribution.weights,
                pityBefore.lastRewardKey
            );
            const rerolled = selectWeightedWithScale(filtered, randomInt);
            if (rerolled && rerolled.key !== initiallySelected.key) {
                originallySelected = rerolled;
                antiRepeatApplied = true;
            }
        }

        let ownedTitleAvoidanceApplied = false;
        let ownedTitleAvoidanceFrom = null;
        if (
            distribution.quality.hardActive
            && originallySelected?.type === 'title'
            && originallySelected?.templateKey
        ) {
            const titleTable = await db.get(
                \`SELECT 1 AS present
                 FROM sqlite_master
                 WHERE type = 'table' AND name = 'clover_player_titles'\`
            );
            const ownedTitle = titleTable
                ? await db.get(
                    \`SELECT id
                     FROM clover_player_titles
                     WHERE player_id = ? AND title_key = ? COLLATE NOCASE
                     LIMIT 1\`,
                    [playerId, originallySelected.templateKey]
                )
                : null;
            if (ownedTitle) {
                const highAlternatives = distribution.weights.filter(
                    (entry) => entry.units > 0
                        && entry.reward.pityTier === 'high_non_relic'
                        && entry.reward.key !== originallySelected.key
                );
                const repeatSafeAlternatives = filterRepeatWeights(
                    highAlternatives,
                    pityBefore.lastRewardKey
                );
                const replacement = selectWeightedWithScale(
                    repeatSafeAlternatives,
                    randomInt
                );
                if (replacement) {
                    ownedTitleAvoidanceApplied = true;
                    ownedTitleAvoidanceFrom = originallySelected.key;
                    originallySelected = replacement;
                }
            }
        }

        const resolved = await resolveRewardInTransaction(`,
        },
        {
            label: 'metadados auditáveis das proteções extras',
            before: `                antiRepeat: {
                    applied: antiRepeatApplied,
                    from: antiRepeatApplied ? initiallySelected.key : null,
                    to: antiRepeatApplied ? originallySelected.key : null,
                },
                relicPool: {
                    availableBefore: availableRelicKeys.length,
                    frozen: availableRelicKeys.length === 0,
                },`,
            after: `                antiRepeat: {
                    applied: antiRepeatApplied,
                    from: antiRepeatApplied ? initiallySelected.key : null,
                    to: antiRepeatApplied ? originallySelected.key : null,
                },
                ownedTitleAvoidance: {
                    applied: ownedTitleAvoidanceApplied,
                    from: ownedTitleAvoidanceApplied ? ownedTitleAvoidanceFrom : null,
                    to: ownedTitleAvoidanceApplied ? originallySelected.key : null,
                },
                relicFallbackAntiRepeat: {
                    applied: Boolean(resolved.fallbackAntiRepeatApplied),
                    from: resolved.fallbackAntiRepeatApplied
                        ? pityBefore.lastRewardKey
                        : null,
                    to: resolved.fallbackAntiRepeatApplied ? reward.key : null,
                },
                relicPool: {
                    availableBefore: availableRelicKeys.length,
                    frozen: availableRelicKeys.length === 0,
                },`,
        },
        {
            label: 'metadados de consumo das proteções extras',
            before: `                anti_repeat_applied: antiRepeatApplied,
                pity_before: pityBeforePublic,`,
            after: `                anti_repeat_applied: antiRepeatApplied,
                owned_title_avoidance_applied: ownedTitleAvoidanceApplied,
                relic_fallback_anti_repeat_applied: Boolean(
                    resolved.fallbackAntiRepeatApplied
                ),
                pity_before: pityBeforePublic,`,
        },
        {
            label: 'recibo inclui proteções extras',
            before: `            antiRepeat: openingMetadata.pity.antiRepeat,
            relicPool: openingMetadata.pity.relicPool,`,
            after: `            antiRepeat: openingMetadata.pity.antiRepeat,
            ownedTitleAvoidance: openingMetadata.pity.ownedTitleAvoidance,
            relicFallbackAntiRepeat: openingMetadata.pity.relicFallbackAntiRepeat,
            relicPool: openingMetadata.pity.relicPool,`,
        },
    ]);
}

function run() {
    applyBaseIntegration();
    applySafetyPatches();
    console.log('[box-pity-final] Integração final aplicada. Execute testes e simulação antes de remover os scripts temporários.');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error(`[box-pity-final] ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { applySafetyPatches, run };
