'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {COMMAND_PREFIX}=require('../config/bot');

const {
    PHASES,
    canUseCommandInPhase,
} = require('../helpers/clover/playerPhase');

test('PRE_RESET permite #retorno e bloqueia comandos normais mesmo fora da lista de jogo', () => {
    assert.equal(canUseCommandInPhase('#retorno', PHASES.PRE_RESET_DECISION), true);
    assert.equal(canUseCommandInPhase(COMMAND_PREFIX+'return', PHASES.PRE_RESET_DECISION), true);
    assert.equal(canUseCommandInPhase(COMMAND_PREFIX+'status', PHASES.PRE_RESET_DECISION), true);
    assert.equal(canUseCommandInPhase(COMMAND_PREFIX+'perfil', PHASES.PRE_RESET_DECISION, { isGameCommand: true }), false);
    assert.equal(canUseCommandInPhase(COMMAND_PREFIX+'ficha', PHASES.PRE_RESET_DECISION), false);
    assert.equal(canUseCommandInPhase(COMMAND_PREFIX+'qualquercoisa', PHASES.PRE_RESET_DECISION), false);
});

test('freeze PRE_RESET vale para criação e espera; Owner nao recebe bypass de lifecycle', () => {
    assert.equal(canUseCommandInPhase(COMMAND_PREFIX+'sortear', PHASES.PRE_RESET_BUILD), true);
    assert.equal(canUseCommandInPhase(COMMAND_PREFIX+'perfil', PHASES.PRE_RESET_WAIT), false);
    assert.equal(canUseCommandInPhase(COMMAND_PREFIX+'perfil', PHASES.PRE_RESET_WAIT, { allowGameBypass: true }), false);
});
