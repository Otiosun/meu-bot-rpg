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

test('migration de snapshot permanece registrada e aplicada mesmo com migrations posteriores', async (t) => {
    assert.equal(RETURN_POINT_SHOP_ELIGIBILITY_VERSION, 42);
    const registered = CURRENT_SCHEMA_MIGRATIONS.filter((entry) => entry.version === RETURN_POINT_SHOP_ELIGIBILITY_VERSION);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].key, RETURN_POINT_SHOP_ELIGIBILITY_MIGRATION.key);
    const fs = require('node:fs');
    const path = require('node:path');
    const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'clover-shop-snapshot-'));
    const db = await require('../database').criarBanco({ filename: path.join(directory, 'database.sqlite') });
    t.after(async () => {
        await db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const applied = await db.get('SELECT version, migration_key AS key FROM clover_schema_migrations WHERE version = ?', [RETURN_POINT_SHOP_ELIGIBILITY_VERSION]);
    assert.deepEqual(applied, { version: registered[0].version, key: registered[0].key });
    const { inspectReturnPointShopEligibilitySchemaState } = require('../helpers/clover/returnPointShopEligibilityMigration');
    assert.equal((await inspectReturnPointShopEligibilitySchemaState(db)).kind, 'exact');
});

test('repetir a mesma compra no mesmo roll é conflito HTTP 409', () => {
    assert.equal(statusFor({ code: 'return_shop_target_already_purchased' }), 409);
});
