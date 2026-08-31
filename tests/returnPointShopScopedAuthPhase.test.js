'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { COMMAND_PREFIX } = require('../config/bot');
const {
    PHASES,
    canUseCommandInPhase,
    getAllowedCommandsForPhase,
} = require('../helpers/clover/playerPhase');

const SHOP_COMMAND = `${COMMAND_PREFIX}lojaretorno`;
const SITE_COMMAND = `${COMMAND_PREFIX}site`;

for (const phase of [PHASES.PRE_RESET_DECISION, PHASES.PRE_RESET_BUILD, PHASES.PRE_RESET_WAIT]) {
    test(`login exclusivo da Loja de Retorno e permitido em ${phase}`, () => {
        assert.equal(canUseCommandInPhase(SHOP_COMMAND, phase), true);
        assert.ok(getAllowedCommandsForPhase(phase).includes(SHOP_COMMAND));
    });

    test(`login geral do site continua bloqueado em ${phase}`, () => {
        assert.equal(canUseCommandInPhase(SITE_COMMAND, phase), false);
    });
}
