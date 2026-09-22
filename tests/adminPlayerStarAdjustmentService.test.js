'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    AdminPlayerStarAdjustmentError,
    createPlayerStarAdjustmentExecutors,
    normalizeStarAdjustmentPayload,
    projectedSnapshot,
} = require('../helpers/clover/adminPlayerStarAdjustmentService');

test('star adjustment accepts positive and negative integer deltas', () => {
    assert.deepEqual(normalizeStarAdjustmentPayload({ amount: 4 }), { amount: 4, syncSquad: true });
    assert.deepEqual(normalizeStarAdjustmentPayload({ delta: -2, syncSquad: false }), { amount: -2, syncSquad: false });
});

test('star adjustment blocks negative player balance', () => {
    assert.throws(
        () => projectedSnapshot({ stars: 1, storedPatent: '-', squad: null }, -2, false),
        (error) => error instanceof AdminPlayerStarAdjustmentError && error.code === 'player_stars_below_zero'
    );
});

test('star adjustment previews recommended patent from resulting stars', () => {
    const before = {
        stars: 2,
        storedPatent: '-',
        effectivePatent: 'Cavaleiro Mágico Júnior de 5ª Classe',
        recommendedPatent: 'Cavaleiro Mágico Júnior de 5ª Classe',
        squad: { key: 'touros_negros', name: 'Touros Negros', balance: 10, season: 8, lifetime: 20 },
    };
    const after = projectedSnapshot(before, 1, true);
    assert.equal(after.stars, 3);
    assert.equal(after.recommendedPatent, 'Cavaleiro Mágico Júnior de 4ª Classe');
    assert.equal(after.effectivePatent, 'Cavaleiro Mágico Júnior de 4ª Classe');
    assert.equal(after.squad.balance, 11);
});

test('star adjustment executor exposes preview apply and undo', () => {
    const executor = createPlayerStarAdjustmentExecutors()['player.stars.adjust'];
    assert.equal(typeof executor?.preview, 'function');
    assert.equal(typeof executor?.apply, 'function');
    assert.equal(typeof executor?.undo, 'function');
});
