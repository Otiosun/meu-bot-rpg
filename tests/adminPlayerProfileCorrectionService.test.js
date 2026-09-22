'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    AdminPlayerProfileCorrectionError,
    createPlayerProfileCorrectionExecutors,
    normalizeProfileCorrectionPayload,
} = require('../helpers/clover/adminPlayerProfileCorrectionService');

test('player profile correction normalizes canonical character name and magic key', () => {
    const value = normalizeProfileCorrectionPayload({
        characterName: '  Noelle Silva  ',
        magicKey: 'magia_de_sombras',
    });
    assert.equal(value.characterName, 'Noelle Silva');
    assert.equal(value.magic.key, 'magia_de_sombras');
    assert.ok(value.magic.label);
});

test('player profile correction rejects unknown magic', () => {
    assert.throws(
        () => normalizeProfileCorrectionPayload({ magicKey: 'magia_inexistente_total' }),
        (error) => error instanceof AdminPlayerProfileCorrectionError && error.code === 'magic_not_found'
    );
});

test('player profile correction executor is fully reversible', () => {
    const executor = createPlayerProfileCorrectionExecutors()['player.profile.correct'];
    assert.equal(typeof executor?.preview, 'function');
    assert.equal(typeof executor?.apply, 'function');
    assert.equal(typeof executor?.undo, 'function');
});
