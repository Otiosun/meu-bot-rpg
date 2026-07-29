'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    getFamilyEffectiveSocialClassName,
    validateFamilyChoice,
} = require('../helpers/clover/profileRules');

test('familia de classe inferior e permitida para roll humano de classe superior', () => {
    const roll = {
        kingdom_key: 'clover',
        social_class_key: 'realeza',
        race_key: 'humano',
    };

    const validation = validateFamilyChoice('Roselei', roll);

    assert.equal(validation.ok, true);
    assert.equal(validation.family.key, 'roselei');
    assert.equal(validation.effectiveSocialClassKey, 'nobreza');
    assert.equal(getFamilyEffectiveSocialClassName(validation.family, roll), 'Nobreza');
});

test('familia de classe superior continua bloqueada para roll humano de classe inferior', () => {
    const roll = {
        kingdom_key: 'clover',
        social_class_key: 'burguesia',
        race_key: 'humano',
    };

    const validation = validateFamilyChoice('Vermillion', roll);

    assert.equal(validation.ok, false);
    assert.equal(validation.errors.includes('Familia nao compativel com a classe social do roll escolhido.'), true);
});
