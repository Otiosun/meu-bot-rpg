'use strict';

// S51 — contract characterization only. No production DB, WhatsApp or payout.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeMissionDraft,
  MISSION_RANK_GUIDE,
} = require('../helpers/clover/adminMissionService');

function draft(reward, extra = {}) {
  return {
    missionKey: 's51-fixed-reward',
    title: 'Missão sintética',
    rank: 'D',
    mode: 'official',
    location: 'Laboratório',
    missionType: 'support',
    risk: 'Risco sintético',
    description: 'Somente teste',
    deadlineAt: '2099-01-01T00:00:00.000Z',
    reward,
    ...extra,
  };
}

test('S51: contrato legado ainda aceita intervalo de recompensa em rascunho', () => {
  const normalized = normalizeMissionDraft(draft({
    ph: [8, 12], stars: [1, 1], yulls: [900, 1500],
  }));
  assert.deepEqual(normalized.reward.ph, [8, 12]);
  assert.deepEqual(normalized.reward.yulls, [900, 1500]);
  assert.deepEqual(MISSION_RANK_GUIDE.D.ph, [8, 12]);
});

test('S51: valores exatos permanecem representáveis sem alterar o esquema legado', () => {
  const normalized = normalizeMissionDraft(draft({
    ph: [10, 10], stars: [1, 1], yulls: [1200, 1200],
  }), { forPublish: true });
  assert.deepEqual(normalized.reward, {
    ph: [10, 10],
    stars: [1, 1],
    yulls: [1200, 1200],
    extra: null,
    exceptionalAnnouncement: null,
  });
});

test('S51: flag de salário é metadado, não autorização de pagamento', () => {
  assert.equal(normalizeMissionDraft(draft({ ph: [10, 10], stars: [1, 1], yulls: [1200, 1200] })).countsForSalary, true);
  assert.equal(normalizeMissionDraft(draft({ ph: [10, 10], stars: [1, 1], yulls: [1200, 1200] }, { countsForSalary: false })).countsForSalary, false);
});

test.todo('R23: publicação rejeita intervalos min != max e congela pacote por versão');
test.todo('R23: bônus extraordinário possui recibo e autorização separados do pagamento-base');
test.todo('R23: dupla aprovação concorrente credita pacote-base uma única vez');
