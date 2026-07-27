'use strict';

const ROLL_SCALE = 10000;

const BOX_PITY_POLICY = Object.freeze({
    simples: Object.freeze({
        quality: Object.freeze({
            softAfterMisses: 8,
            hardAtOpening: 12,
            softBonusPercentagePoints: 3,
        }),
        relic: Object.freeze({
            boostAfterMisses: 5,
            stepBaseMultiplier: 0.10,
            maxMultiplier: 2.5,
            maxAbsoluteBonusPercentagePoints: 1.5,
        }),
    }),
    rara: Object.freeze({
        quality: Object.freeze({
            softAfterMisses: 5,
            hardAtOpening: 8,
            softBonusPercentagePoints: 5,
        }),
        relic: Object.freeze({
            boostAfterMisses: 5,
            stepBaseMultiplier: 0.10,
            maxMultiplier: 2.5,
            maxAbsoluteBonusPercentagePoints: 1.5,
        }),
    }),
});

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function chanceToUnits(chance) {
    return Math.max(0, Math.round(Number(chance || 0) * 100));
}

function unitsToChance(units) {
    return Math.round((Number(units || 0) / 100) * 10000) / 10000;
}

function getBoxPityPolicy(boxKey) {
    return BOX_PITY_POLICY[String(boxKey || '').trim().toLowerCase()] || null;
}

function getRelicReward(box) {
    return box?.rewards?.find((reward) => reward.pityTier === 'ultra_relic') || null;
}

function isQualitySuccessReward(reward) {
    return Boolean(reward?.qualitySuccess)
        || reward?.pityTier === 'high_non_relic'
        || reward?.pityTier === 'ultra_relic';
}

function effectiveRelicChance(box, relicMissStreak) {
    const policy = getBoxPityPolicy(box?.key);
    const relicReward = getRelicReward(box);
    const baseChance = Number(relicReward?.chance || 0);
    const misses = Math.max(0, Number(relicMissStreak || 0));

    if (!policy || !relicReward || baseChance <= 0) {
        return {
            baseChance,
            effectiveChance: baseChance,
            multiplier: 1,
            boostSteps: 0,
            capped: false,
        };
    }

    const boostSteps = Math.max(0, misses - policy.relic.boostAfterMisses + 1);
    const uncappedMultiplier = 1 + boostSteps * policy.relic.stepBaseMultiplier;
    const multiplier = Math.min(policy.relic.maxMultiplier, uncappedMultiplier);
    const multiplierChance = baseChance * multiplier;
    const absoluteCapChance = baseChance + policy.relic.maxAbsoluteBonusPercentagePoints;
    const effectiveChance = Math.min(multiplierChance, absoluteCapChance);

    return {
        baseChance,
        effectiveChance: Math.round(effectiveChance * 10000) / 10000,
        multiplier: Math.round(multiplier * 10000) / 10000,
        boostSteps,
        capped: effectiveChance < multiplierChance || multiplier >= policy.relic.maxMultiplier,
    };
}

function qualityPityStatus(boxKey, qualityMissStreak) {
    const policy = getBoxPityPolicy(boxKey);
    const misses = Math.max(0, Number(qualityMissStreak || 0));
    if (!policy) {
        return {
            misses,
            softActive: false,
            softSteps: 0,
            hardActive: false,
            nextHardIn: null,
        };
    }

    const hardActive = misses >= policy.quality.hardAtOpening - 1;
    const softSteps = hardActive
        ? 0
        : Math.max(0, misses - policy.quality.softAfterMisses + 1);

    return {
        misses,
        softActive: softSteps > 0,
        softSteps,
        hardActive,
        nextHardIn: hardActive
            ? 0
            : Math.max(0, policy.quality.hardAtOpening - (misses + 1)),
    };
}

function allocateProportionally(entries, targetUnits) {
    const positive = entries.filter((entry) => entry.baseUnits > 0);
    if (!positive.length || targetUnits <= 0) {
        return new Map(entries.map((entry) => [entry.reward.key, 0]));
    }

    const totalBase = positive.reduce((sum, entry) => sum + entry.baseUnits, 0);
    const raw = positive.map((entry) => {
        const exact = targetUnits * entry.baseUnits / totalBase;
        const floor = Math.floor(exact);
        return { ...entry, units: floor, remainder: exact - floor };
    });
    let remaining = targetUnits - raw.reduce((sum, entry) => sum + entry.units, 0);
    raw.sort((left, right) => right.remainder - left.remainder || left.reward.key.localeCompare(right.reward.key));
    for (let index = 0; index < raw.length && remaining > 0; index += 1, remaining -= 1) {
        raw[index].units += 1;
    }

    const result = new Map(entries.map((entry) => [entry.reward.key, 0]));
    for (const entry of raw) result.set(entry.reward.key, entry.units);
    return result;
}

function buildEffectiveRewardWeights(box, pityState = {}) {
    const policy = getBoxPityPolicy(box?.key);
    if (!box || !policy) throw new Error('Política de pity não encontrada para a Caixa.');

    const entries = box.rewards.map((reward) => ({
        reward,
        baseUnits: chanceToUnits(reward.chance),
    }));
    const relicEntry = entries.find((entry) => entry.reward.pityTier === 'ultra_relic');
    if (!relicEntry) throw new Error('A Caixa não possui recompensa marcada como ultra_relic.');

    const relicChance = effectiveRelicChance(box, pityState.relicMissStreak);
    const relicUnits = clamp(chanceToUnits(relicChance.effectiveChance), 0, ROLL_SCALE);
    const nonRelicEntries = entries.filter((entry) => entry !== relicEntry);
    const highEntries = nonRelicEntries.filter((entry) => entry.reward.pityTier === 'high_non_relic');
    const otherEntries = nonRelicEntries.filter((entry) => entry.reward.pityTier !== 'high_non_relic');
    const baseNonRelicUnits = nonRelicEntries.reduce((sum, entry) => sum + entry.baseUnits, 0);
    const baseHighUnits = highEntries.reduce((sum, entry) => sum + entry.baseUnits, 0);
    const remainingUnits = ROLL_SCALE - relicUnits;
    const quality = qualityPityStatus(box.key, pityState.qualityMissStreak);

    const baselineHighUnits = baseNonRelicUnits > 0
        ? Math.round(remainingUnits * baseHighUnits / baseNonRelicUnits)
        : 0;
    const softBonusUnits = quality.softSteps
        * chanceToUnits(policy.quality.softBonusPercentagePoints);
    const highTargetUnits = quality.hardActive
        ? remainingUnits
        : clamp(baselineHighUnits + softBonusUnits, 0, remainingUnits);
    const otherTargetUnits = remainingUnits - highTargetUnits;

    const highAllocation = allocateProportionally(highEntries, highTargetUnits);
    const otherAllocation = allocateProportionally(otherEntries, otherTargetUnits);
    const weights = box.rewards.map((reward) => ({
        reward,
        units: reward === relicEntry.reward
            ? relicUnits
            : (highAllocation.get(reward.key) || otherAllocation.get(reward.key) || 0),
    }));
    const totalUnits = weights.reduce((sum, entry) => sum + entry.units, 0);
    if (totalUnits !== ROLL_SCALE) {
        throw new Error(`Distribuição de pity inválida: ${totalUnits}/${ROLL_SCALE}.`);
    }

    return {
        weights,
        relicChance,
        quality,
        highChance: unitsToChance(highTargetUnits),
        otherChance: unitsToChance(otherTargetUnits),
        totalUnits,
    };
}

function selectRewardFromWeights(weights, rollUnits) {
    const roll = clamp(Number(rollUnits || 0), 1, ROLL_SCALE);
    let ceiling = 0;
    for (const entry of weights) {
        ceiling += Number(entry.units || 0);
        if (roll <= ceiling) return entry.reward;
    }
    return weights[weights.length - 1]?.reward || null;
}

function filterRepeatWeights(weights, lastRewardKey) {
    const key = String(lastRewardKey || '').trim();
    if (!key) return weights;
    const alternatives = weights.filter((entry) => entry.reward.key !== key && entry.units > 0);
    if (!alternatives.length) return weights;
    return alternatives;
}

function selectWeightedWithScale(weights, randomInt) {
    const total = weights.reduce((sum, entry) => sum + Number(entry.units || 0), 0);
    if (total <= 0) return null;
    const roll = randomInt(1, total + 1);
    let ceiling = 0;
    for (const entry of weights) {
        ceiling += Number(entry.units || 0);
        if (roll <= ceiling) return entry.reward;
    }
    return weights[weights.length - 1]?.reward || null;
}

module.exports = {
    BOX_PITY_POLICY,
    ROLL_SCALE,
    buildEffectiveRewardWeights,
    chanceToUnits,
    effectiveRelicChance,
    filterRepeatWeights,
    getBoxPityPolicy,
    getRelicReward,
    isQualitySuccessReward,
    qualityPityStatus,
    selectRewardFromWeights,
    selectWeightedWithScale,
    unitsToChance,
};
