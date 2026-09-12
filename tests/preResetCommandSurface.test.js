'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
    'tentativa',
    'sacrificar',
    'reinos',
    'racas',
    'classes',
    'grimorios',
];

const intentionallyBlocked = [
    'start',
    'historia',
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

test('magia PRE_RESET intercepta antes de qualquer acesso ao fluxo legado', () => {
    const commandSource = fs.readFileSync(path.join(__dirname, '../comandos/magia.js'), 'utf8');
    const futureCall = commandSource.indexOf('tryExecutePreResetMagic');
    const legacyAccess = commandSource.indexOf('ensurePlayerRecord(db');
    assert.ok(futureCall >= 0 && legacyAccess >= 0 && futureCall < legacyAccess);

    const helperSource = fs.readFileSync(path.join(__dirname, '../helpers/clover/preResetMagicCommand.js'), 'utf8');
    for (const forbidden of ['UPDATE jogadores', 'player_rolls', 'pending_magic_confirmations', 'ensurePlayerRecord']) {
        assert.equal(helperSource.includes(forbidden), false, forbidden);
    }
});

test('tracos PRE_RESET reutiliza motor de tentativa com identidade futura isolada', () => {
    const source = fs.readFileSync(path.join(__dirname, '../comandos/tracos.js'), 'utf8');
    assert.ok(source.includes('getFutureTraitIdentity(idJogador)'));
    assert.ok(source.includes('runSpecialAttempt(db, attemptPlayerId'));
    assert.ok(source.includes("source:'tracos-prereset'"));
});

test('sacrificar PRE_RESET intercepta antes de qualquer leitura do personagem legado', () => {
    const source = fs.readFileSync(path.join(__dirname, '../comandos/sacrificar.js'), 'utf8');
    const futureCall = source.indexOf('tryExecutePreResetSacrifice');
    const legacyAccess = source.indexOf('ensurePlayerRecord(db');
    assert.ok(futureCall >= 0 && legacyAccess >= 0 && futureCall < legacyAccess);
});
