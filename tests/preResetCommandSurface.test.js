'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { COMMAND_PREFIX } = require('../config/bot');
const {
    PHASES,
    canUseCommandInPhase,
    getAllowedCommandsForPhase,
} = require('../helpers/clover/playerPhase');

const buildCommands = [
    'magia',
    'cancelarmagia',
    'familias',
    'tracos',
    'reinos',
    'racas',
    'classes',
    'grimorios',
];

const intentionallyBlocked = [
    'start',
    'historia',
    'sacrificar',
];

test('PRE_RESET build libera consultas/criacao futura sem abrir fluxo legado inteiro', () => {
    for (const command of buildCommands) {
        assert.equal(
            canUseCommandInPhase(`${COMMAND_PREFIX}${command}`, PHASES.PRE_RESET_BUILD),
            true,
            `${command} deveria estar liberado no PRE_RESET build`
        );
    }

    for (const command of intentionallyBlocked) {
        assert.equal(
            canUseCommandInPhase(`${COMMAND_PREFIX}${command}`, PHASES.PRE_RESET_BUILD),
            false,
            `${command} deve continuar bloqueado no PRE_RESET build`
        );
    }
});

test('PRE_RESET wait nao herda comandos de criacao do build', () => {
    for (const command of buildCommands) {
        assert.equal(
            canUseCommandInPhase(`${COMMAND_PREFIX}${command}`, PHASES.PRE_RESET_WAIT),
            false,
            `${command} nao deve abrir criacao para jogador em MANTER/WAIT`
        );
    }
});

test('lista de comandos anunciada pelo build inclui a superficie segura', () => {
    const allowed = new Set(getAllowedCommandsForPhase(PHASES.PRE_RESET_BUILD));
    for (const command of buildCommands) {
        assert.equal(allowed.has(`${COMMAND_PREFIX}${command}`), true, command);
    }
});
