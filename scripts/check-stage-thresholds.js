const assert = require('node:assert/strict');
const stages = require('../data/clover/estagios.json');

const expected = {
  9: 0,
  8: 80,
  7: 220,
  6: 450,
  5: 1000,
  4: 1900,
  3: 3000,
  2: 4000,
  1: 5700,
  0: 7000,
  arcano: null,
};

assert.equal(stages.length, 11, 'O catálogo deve conter os dez estágios comuns e o Arcano.');

for (const stage of stages) {
  assert.ok(Object.prototype.hasOwnProperty.call(expected, stage.key), `Estágio inesperado: ${stage.key}`);
  assert.equal(stage.ph_required, expected[stage.key], `PH incorreto no ${stage.name}.`);
  assert.equal(stage.automatic, stage.key !== 'arcano', `Automação incorreta no ${stage.name}.`);
}

for (let index = 1; index < stages.length - 1; index += 1) {
  assert.ok(
    Number(stages[index].ph_required) > Number(stages[index - 1].ph_required),
    `Os requisitos precisam crescer: ${stages[index - 1].name} → ${stages[index].name}.`,
  );
}

console.log('✓ requisitos oficiais de PH por estágio validados');
