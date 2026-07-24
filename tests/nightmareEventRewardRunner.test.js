'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { transformSource } = require('../scripts/runNightmareEventRewards');

test('runner consolida nome canônico e endurece resolução por telefone', () => {
    const sourcePath = path.join(__dirname, '..', 'scripts', 'applyNightmareEventRewards.js');
    const transformed = transformSource(fs.readFileSync(sourcePath, 'utf8'));

    assert.match(transformed, /characterName: 'Kame Van Rothtaylor'/);
    assert.match(transformed, /function playerHasPhoneConfirmedCharacter/);
    assert.match(transformed, /const meaningfulPhoneCandidates/);
    assert.match(transformed, /matchingPhoneCandidates\.length === 1 && meaningfulPhoneCandidates\.length === 1/);
    assert.match(transformed, /também está ligado a outro personagem real/);
});

test('runner não modifica o arquivo-fonte da premiação', () => {
    const sourcePath = path.join(__dirname, '..', 'scripts', 'applyNightmareEventRewards.js');
    const before = fs.readFileSync(sourcePath, 'utf8');
    transformSource(before);
    const after = fs.readFileSync(sourcePath, 'utf8');
    assert.equal(after, before);
});
