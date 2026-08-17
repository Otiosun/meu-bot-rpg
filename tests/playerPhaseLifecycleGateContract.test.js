'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    PHASES,
    canUseCommandInPhase,
} = require('../helpers/clover/playerPhase');

test('lifecycle archived bloqueia até comando não-game', () => {
    assert.equal(canUseCommandInPhase('status', PHASES.JOGO_LIBERADO, {
        isGameCommand: false,
        lifecycleStatus: 'archived',
        gameStatus: 'liberado',
    }), false);
});

test('jogo arquivado bloqueia até comando não-game', () => {
    assert.equal(canUseCommandInPhase('status', PHASES.JOGO_LIBERADO, {
        isGameCommand: false,
        lifecycleStatus: 'active',
        gameStatus: 'arquivado',
    }), false);
});

test('estado ativo mantém comando não-game permitido', () => {
    assert.equal(canUseCommandInPhase('status', PHASES.JOGO_LIBERADO, {
        isGameCommand: false,
        lifecycleStatus: 'active',
        gameStatus: 'liberado',
    }), true);
});

test('index encaminha lifecycle e game status ao gate de fase', () => {
    const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.match(indexSource, /lifecycleStatus:\s*phaseInfo\.player\?\.lifecycle_status/);
    assert.match(indexSource, /gameStatus:\s*phaseInfo\.player\?\.jogo_status/);
});
