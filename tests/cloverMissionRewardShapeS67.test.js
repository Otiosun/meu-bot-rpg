'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMissionDraft } = require('../helpers/clover/adminMissionService');

function mission(reward) {
    return {
        missionKey: 'reward-shape-regression-01',
        title: 'Patrulha de fronteira',
        rank: 'D',
        mode: 'official',
        missionType: 'investigation',
        location: 'Fronteira de Clover',
        description: 'Inspecionar a rota.',
        risk: 'Risco moderado.',
        slots: 4,
        deadlineAt: '2030-01-01T00:00:00.000Z',
        specialConditions: 'Relatar a patrulha.',
        failureConsequence: 'Rota desprotegida.',
        reward,
    };
}

test('explicit malformed reward fields never silently become rank defaults', () => {
    for (const field of ['ph', 'stars', 'yulls']) {
        for (const malformed of [null, 0, 10, '10', {}, [1], [1, 2, 3]]) {
            const reward = { ph: [8, 8], stars: [1, 1], yulls: [900, 900], [field]: malformed };
            assert.throws(
                () => normalizeMissionDraft(mission(reward)),
                (error) => error?.code === 'invalid_mission_reward_range',
                field + ' must reject ' + JSON.stringify(malformed)
            );
        }
    }
});

test('omitted individual reward fields preserve legacy draft defaults', () => {
    const normalized = normalizeMissionDraft(mission({ ph: [8, 8] }));
    assert.deepEqual(normalized.reward.ph, [8, 8]);
    assert.deepEqual(normalized.reward.stars, [1, 1]);
    assert.deepEqual(normalized.reward.yulls, [900, 1500]);
});

test('explicit valid fixed reward values are preserved', () => {
    const normalized = normalizeMissionDraft(mission({
        ph: [10, 10], stars: [1, 1], yulls: [1200, 1200],
    }));
    assert.deepEqual(normalized.reward.ph, [10, 10]);
    assert.deepEqual(normalized.reward.stars, [1, 1]);
    assert.deepEqual(normalized.reward.yulls, [1200, 1200]);
});
