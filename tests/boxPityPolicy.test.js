'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { getBoxCatalog, validateBoxCatalogs } = require('../helpers/clover/seasonalEventCatalog');
const {
    buildEffectiveRewardWeights,
    effectiveRelicChance,
    filterRepeatWeights,
    qualityPityStatus,
    selectRewardFromWeights,
} = require('../helpers/clover/boxPityPolicy');

test('catálogos preservam 100% e expõem tiers de pity auditáveis', () => {
    const validation = validateBoxCatalogs();
    const simple = validation.find((entry) => entry.key === 'simples');
    const rare = validation.find((entry) => entry.key === 'rara');

    assert.equal(simple.totalChance, 100);
    assert.equal(simple.tierTotals.high_non_relic, 12);
    assert.equal(simple.tierTotals.ultra_relic, 0.1);

    assert.equal(rare.totalChance, 100);
    assert.equal(rare.tierTotals.high_non_relic, 13);
    assert.equal(rare.tierTotals.ultra_relic, 0.2);
});

test('pity de Relíquia começa após cinco falhas e respeita teto de 2,5x', () => {
    const simple = getBoxCatalog('simples');
    const rare = getBoxCatalog('rara');

    assert.equal(effectiveRelicChance(simple, 0).effectiveChance, 0.1);
    assert.equal(effectiveRelicChance(simple, 4).effectiveChance, 0.1);
    assert.equal(effectiveRelicChance(simple, 5).effectiveChance, 0.11);
    assert.equal(effectiveRelicChance(simple, 19).effectiveChance, 0.25);
    assert.equal(effectiveRelicChance(simple, 200).effectiveChance, 0.25);

    assert.equal(effectiveRelicChance(rare, 0).effectiveChance, 0.2);
    assert.equal(effectiveRelicChance(rare, 5).effectiveChance, 0.22);
    assert.equal(effectiveRelicChance(rare, 19).effectiveChance, 0.5);
    assert.equal(effectiveRelicChance(rare, 200).effectiveChance, 0.5);
});

test('pity de qualidade ativa soft e hard nas aberturas corretas', () => {
    assert.deepEqual(qualityPityStatus('simples', 7), {
        misses: 7,
        softActive: false,
        softSteps: 0,
        hardActive: false,
        nextHardIn: 4,
    });
    assert.equal(qualityPityStatus('simples', 8).softSteps, 1);
    assert.equal(qualityPityStatus('simples', 10).softSteps, 3);
    assert.equal(qualityPityStatus('simples', 11).hardActive, true);

    assert.equal(qualityPityStatus('rara', 4).softActive, false);
    assert.equal(qualityPityStatus('rara', 5).softSteps, 1);
    assert.equal(qualityPityStatus('rara', 6).softSteps, 2);
    assert.equal(qualityPityStatus('rara', 7).hardActive, true);
});

test('pesos efetivos preservam massa total e reservam Relíquia antes da qualidade', () => {
    const simple = getBoxCatalog('simples');
    const base = buildEffectiveRewardWeights(simple, {
        qualityMissStreak: 0,
        relicMissStreak: 0,
    });
    const soft = buildEffectiveRewardWeights(simple, {
        qualityMissStreak: 8,
        relicMissStreak: 5,
    });
    const hard = buildEffectiveRewardWeights(simple, {
        qualityMissStreak: 11,
        relicMissStreak: 5,
    });

    assert.equal(base.totalUnits, 10000);
    assert.equal(base.highChance, 12);
    assert.equal(base.relicChance.effectiveChance, 0.1);

    assert.equal(soft.totalUnits, 10000);
    assert.equal(soft.highChance, 15);
    assert.equal(soft.relicChance.effectiveChance, 0.11);

    assert.equal(hard.totalUnits, 10000);
    assert.equal(hard.quality.hardActive, true);
    assert.equal(hard.relicChance.effectiveChance, 0.11);
    assert.equal(hard.highChance, 99.89);
    assert.equal(hard.otherChance, 0);
});

test('hard pity nunca força Relíquia e mantém Relíquia elegível apenas na massa própria', () => {
    const rare = getBoxCatalog('rara');
    const hard = buildEffectiveRewardWeights(rare, {
        qualityMissStreak: 7,
        relicMissStreak: 19,
    });
    const relicWeight = hard.weights.find((entry) => entry.reward.pityTier === 'ultra_relic');
    const nonHigh = hard.weights.filter((entry) => !['high_non_relic', 'ultra_relic'].includes(entry.reward.pityTier));

    assert.equal(relicWeight.units, 50);
    assert.equal(nonHigh.every((entry) => entry.units === 0), true);
    assert.equal(selectRewardFromWeights(hard.weights, 50).pityTier, 'ultra_relic');
    assert.equal(selectRewardFromWeights(hard.weights, 51).pityTier, 'high_non_relic');
});

test('anti-repetição remove a recompensa anterior quando existe alternativa válida', () => {
    const simple = getBoxCatalog('simples');
    const distribution = buildEffectiveRewardWeights(simple, {
        qualityMissStreak: 0,
        relicMissStreak: 0,
    });
    const filtered = filterRepeatWeights(distribution.weights, 'yulls_1000_3000');

    assert.equal(filtered.some((entry) => entry.reward.key === 'yulls_1000_3000'), false);
    assert.equal(filtered.some((entry) => entry.units > 0), true);
});
