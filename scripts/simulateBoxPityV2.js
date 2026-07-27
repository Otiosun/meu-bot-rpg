'use strict';

const { getBoxCatalog } = require('../helpers/clover/seasonalEventCatalog');
const {
    buildEffectiveRewardWeights,
    isQualitySuccessReward,
    selectRewardFromWeights,
} = require('../helpers/clover/boxPityPolicy');

function seededRandom(seed = 0xC10B3E) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function percentile(values, ratio) {
    if (!values.length) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
    return sorted[index];
}

function simulateBox(boxKey, openings = 1000000, seed = 0xC10B3E) {
    const box = getBoxCatalog(boxKey);
    if (!box) throw new Error(`Caixa desconhecida: ${boxKey}`);
    const random = seededRandom(seed);
    const counts = new Map();
    const qualityStreaks = [];
    const relicStreaks = [];
    let qualityMissStreak = 0;
    let relicMissStreak = 0;
    let hardPityTriggers = 0;
    let relics = 0;
    let qualitySuccesses = 0;
    let maxQualityStreak = 0;
    let maxRelicStreak = 0;

    for (let index = 0; index < openings; index += 1) {
        const distribution = buildEffectiveRewardWeights(box, {
            qualityMissStreak,
            relicMissStreak,
        });
        if (distribution.quality.hardActive) hardPityTriggers += 1;
        const roll = Math.floor(random() * 10000) + 1;
        const reward = selectRewardFromWeights(distribution.weights, roll);
        counts.set(reward.key, (counts.get(reward.key) || 0) + 1);

        if (reward.pityTier === 'ultra_relic') {
            relics += 1;
            relicStreaks.push(relicMissStreak + 1);
            relicMissStreak = 0;
        } else {
            relicMissStreak += 1;
            maxRelicStreak = Math.max(maxRelicStreak, relicMissStreak);
        }

        if (isQualitySuccessReward(reward)) {
            qualitySuccesses += 1;
            qualityStreaks.push(qualityMissStreak + 1);
            qualityMissStreak = 0;
        } else {
            qualityMissStreak += 1;
            maxQualityStreak = Math.max(maxQualityStreak, qualityMissStreak);
        }
    }

    const rewardRates = Object.fromEntries(
        [...counts.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, count]) => [key, Math.round((count / openings) * 1000000) / 10000])
    );

    return {
        boxKey,
        openings,
        baseRelicChance: box.rewards.find((reward) => reward.pityTier === 'ultra_relic')?.chance || 0,
        observedRelicChance: Math.round((relics / openings) * 1000000) / 10000,
        observedQualitySuccessChance: Math.round((qualitySuccesses / openings) * 1000000) / 10000,
        hardPityFrequency: Math.round((hardPityTriggers / openings) * 1000000) / 10000,
        maxQualityMissStreak: maxQualityStreak,
        maxRelicMissStreak: maxRelicStreak,
        qualitySuccessOpeningPercentiles: {
            p50: percentile(qualityStreaks, 0.50),
            p90: percentile(qualityStreaks, 0.90),
            p99: percentile(qualityStreaks, 0.99),
            max: percentile(qualityStreaks, 1),
        },
        relicOpeningPercentiles: {
            p50: percentile(relicStreaks, 0.50),
            p90: percentile(relicStreaks, 0.90),
            p99: percentile(relicStreaks, 0.99),
            max: percentile(relicStreaks, 1),
        },
        rewardRates,
    };
}

function run() {
    const openings = Math.max(1000, Number(process.argv[2] || 1000000));
    const report = {
        generatedAt: new Date().toISOString(),
        deterministic: true,
        databaseWrites: false,
        reports: [
            simulateBox('simples', openings, 0x51A1E),
            simulateBox('rara', openings, 0xA11CE),
        ],
    };
    console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) run();

module.exports = { percentile, seededRandom, simulateBox };
