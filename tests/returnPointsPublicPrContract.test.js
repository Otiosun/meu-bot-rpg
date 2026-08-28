'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { COMMAND_PREFIX } = require('../config/bot');
const prCommand = require('../comandos/pr');
const { PHASES, canUseCommandInPhase } = require('../helpers/clover/playerPhase');

test('PR publico significa somente Pontos de Retorno', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'comandos', 'pr.js'), 'utf8');

    assert.equal(prCommand.nome, `${COMMAND_PREFIX}pr`);
    assert.equal(prCommand.descricao, 'Consulta seus Pontos de Retorno.');
    assert.ok(prCommand.aliases.includes(`${COMMAND_PREFIX}pontosretorno`));

    assert.match(source, /returnPointsService/);
    assert.match(source, /PONTOS 𝐃𝐄 𝐑𝐄𝐓𝐎𝐑𝐍𝐎|PONTOS DE RETORNO|𝐏𝐎𝐍𝐓𝐎𝐒 𝐃𝐄 𝐑𝐄𝐓𝐎𝐑𝐍𝐎/u);
    assert.doesNotMatch(source, /prService/);
    assert.doesNotMatch(source, /recruitmentService/);
    assert.doesNotMatch(source, /recruitmentGroupService/);
    assert.doesNotMatch(source, /PONTOS DE RECRUTAMENTO/i);
    assert.doesNotMatch(source, /pontosrecrutamento/i);
    assert.doesNotMatch(source, /pontosdivulgacao/i);
});

test('PR de Retorno continua consultavel durante todas as fases PRE_RESET', () => {
    for (const phase of [PHASES.PRE_RESET_DECISION, PHASES.PRE_RESET_BUILD, PHASES.PRE_RESET_WAIT]) {
        assert.equal(canUseCommandInPhase(`${COMMAND_PREFIX}pr`, phase), true, phase);
    }
});
