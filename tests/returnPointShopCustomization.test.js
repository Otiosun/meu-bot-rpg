'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    validatePurchasedRollComposition,
} = require('../comandos/fichanova');
const {
    RETURN_POINT_SHOP_ELIGIBILITY_MIGRATION,
    RETURN_POINT_SHOP_ELIGIBILITY_VERSION,
} = require('../helpers/clover/returnPointShopEligibilityMigration');
const { CURRENT_SCHEMA_MIGRATIONS } = require('../helpers/clover/schemaMigrationPlan');
const { statusFor } = require('../helpers/clover/returnPointShopHttp');

function baseRoll(overrides = {}) {
    return {
        kingdom: 'Clover',
        kingdom_key: 'clover',
        social_class: 'Nobreza',
        social_class_key: 'nobreza',
        race: 'Humano',
        race_key: 'humano',
        grimoire: 'Grimório de 3 Folhas',
        grimoire_key: 'clover_3f',
        ...overrides,
    };
}

test('composição final válida de roll comprado passa sem erro', () => {
    assert.deepEqual(validatePurchasedRollComposition(baseRoll()), []);
    assert.deepEqual(validatePurchasedRollComposition(baseRoll({
        kingdom: 'Diamond',
        kingdom_key: 'diamond',
        grimoire: 'Grimório de Diamante',
        grimoire_key: 'diamond_3f',
    })), []);
});

test('troca de reino pode existir em estado intermediário, mas Ficha Nova bloqueia grimório incompatível', () => {
    const errors = validatePurchasedRollComposition(baseRoll({
        kingdom: 'Diamond',
        kingdom_key: 'diamond',
    }));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Grimório de 3 Folhas não pertence a Diamond/);
});

test('Ficha Nova bloqueia raça incompatível com o reino final', () => {
    const errors = validatePurchasedRollComposition(baseRoll({
        kingdom: 'Diamond',
        kingdom_key: 'diamond',
        race: 'Bruxa',
        race_key: 'bruxa',
        social_class: 'N\/A',
        social_class_key: 'nao_se_aplica',
        grimoire: 'Grimório de Diamante',
        grimoire_key: 'diamond_3f',
    }));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Bruxa não é compatível com Diamond/);
});

test('não-humano não pode fechar Ficha Nova carregando classe humana', () => {
    const errors = validatePurchasedRollComposition(baseRoll({
        race: 'Bruxa',
        race_key: 'bruxa',
    }));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /não usa classe social humana/);
});

test('migration de snapshot é a última migration canônica da loja', () => {
    assert.equal(RETURN_POINT_SHOP_ELIGIBILITY_VERSION, 42);
    assert.equal(CURRENT_SCHEMA_MIGRATIONS.at(-1).version, RETURN_POINT_SHOP_ELIGIBILITY_MIGRATION.version);
    assert.equal(CURRENT_SCHEMA_MIGRATIONS.at(-1).key, RETURN_POINT_SHOP_ELIGIBILITY_MIGRATION.key);
});

test('repetir a mesma compra no mesmo roll é conflito HTTP 409', () => {
    assert.equal(statusFor({ code: 'return_shop_target_already_purchased' }), 409);
});
