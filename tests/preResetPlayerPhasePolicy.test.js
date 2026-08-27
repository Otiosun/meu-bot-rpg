'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    PHASES,
    canUseCommandInPhase,
} = require('../helpers/clover/playerPhase');

test('PRE_RESET permite #retorno e bloqueia comandos normais mesmo fora da lista de jogo', () => {
    assert.equal(canUseCommandInPhase('#retorno', PHASES.PRE_RESET_DECISION), true);
    assert.equal(canUseCommandInPhase('#return', PHASES.PRE_RESET_DECISION), true);
    assert.equal(canUseCommandInPhase('#status', PHASES.PRE_RESET_DECISION), true);
    assert.equal(canUseCommandInPhase('#perfil', PHASES.PRE_RESET_DECISION, { isGameCommand: true }), false);
    assert.equal(canUseCommandInPhase('#ficha', PHASES.PRE_RESET_DECISION), false);
    assert.equal(canUseCommandInPhase('#qualquercoisa', PHASES.PRE_RESET_DECISION), false);
});

test('freeze PRE_RESET vale para criação e espera; bypass administrativo explícito continua possível', () => {
    assert.equal(canUseCommandInPhase('#sortear', PHASES.PRE_RESET_BUILD), false);
    assert.equal(canUseCommandInPhase('#perfil', PHASES.PRE_RESET_WAIT), false);
    assert.equal(canUseCommandInPhase('#perfil', PHASES.PRE_RESET_WAIT, { allowGameBypass: true }), true);
});
