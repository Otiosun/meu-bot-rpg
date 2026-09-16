'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    canStageSupportWeight,
    getMaintenanceCost,
    getMaintenanceRate,
    getManaActivationCost,
    getMinStageForWeight,
    getRetentionDuration,
    getReuseRule,
} = require('../helpers/clover/spellRuntimeRules');

test('Peso x Estagio respeita todos os limites canonicos', () => {
    for (const [weight, stage, expected] of [
        [3, 9, true], [4, 9, false], [4, 8, true],
        [5, 8, false], [5, 7, true], [9, 4, true],
        [10, 4, false], [10, 3, true], [12, 2, true],
        [13, 2, false], [13, 1, true],
    ]) {
        assert.equal(canStageSupportWeight(stage, weight).ok, expected, `W${weight} / ${stage}o`);
    }
    assert.equal(getMinStageForWeight(14), 1);
    assert.equal(canStageSupportWeight(0, 13).special, true);
    assert.equal(canStageSupportWeight('8º Estágio', 4).ok, true);
    assert.equal(canStageSupportWeight('Arcano', 4).special, true);
});

test('custo de ativacao por Peso e especial a partir de W14', () => {
    const expected = [50, 100, 150, 320, 400, 720, 840, 1440, 1620, 2500, 2750, 3000, 3500];
    expected.forEach((cost, index) => assert.equal(getManaActivationCost(index + 1), cost));
    assert.equal(getManaActivationCost(14), null);
    assert.equal(getManaActivationCost(99), null);
});

test('retencao, manutencao e reuso sao perfis explicitos', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(getRetentionDuration), [
        'instantâneo ou até 1 ciclo', 'até 2 ciclos', 'até 3 ciclos',
        'até 5 ciclos', 'até 8 ciclos', 'até 12 ciclos ou cena curta',
        'cena prolongada enquanto houver Mana, fonte e coerência',
    ]);
    assert.deepEqual([
        'instant', 'sustained_user', 'field_structure', 'caster_fed_autonomous', 'detached',
    ].map(getMaintenanceRate), [0, 0.2, 0.3, 0.4, null]);
    assert.equal(getMaintenanceCost(320, 'field_structure'), 96);
    assert.equal(getMaintenanceCost(50, 'detached'), null);

    assert.equal(getReuseRule('instant').cooldownCycles, 0);
    assert.equal(getReuseRule('sustained').allowsDuplicateWhileActive, false);
    assert.equal(getReuseRule('reaction').kind, 'action_economy');
    assert.equal(getReuseRule('overcharge').cooldownCycles, 1);
    assert.equal(getReuseRule('field').allowsDuplicateWhileActive, false);
    assert.equal(getReuseRule('special').special, true);
    assert.equal(getReuseRule('instant', { weight: 13 }).cooldownCycles, 0);
});
