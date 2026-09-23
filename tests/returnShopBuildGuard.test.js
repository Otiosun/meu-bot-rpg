'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { assertReturnShopCharacterReady, assertReturnShopSacrificeAllowed, assertReturnShopLaunchReady } = require('../helpers/clover/returnShopBuildGuard');

async function fixture(t, metadata, status = 'active') {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    t.after(() => db.close());
    await db.exec(`CREATE TABLE jogadores(id TEXT PRIMARY KEY);
        INSERT INTO jogadores VALUES('p');
        CREATE TABLE clover_prereset_purchases(id INTEGER PRIMARY KEY,status TEXT,catalog_item_key TEXT,metadata_json TEXT);
        CREATE TABLE clover_prereset_entitlements(id INTEGER PRIMARY KEY,purchase_id INTEGER,player_id TEXT,status TEXT,metadata_json TEXT);
        INSERT INTO clover_prereset_purchases VALUES(1,'completed','return_shop_global_package','{}');`);
    await db.run('INSERT INTO clover_prereset_entitlements VALUES(1,1,?,?,?)', ['p',status,JSON.stringify(metadata)]);
    return db;
}

test('compra nao aplicada impede envio mas permite preparar rascunho', async t => {
    const db = await fixture(t, { requires_roll_assignment: true, target_roll_number: 2 });
    await assertReturnShopCharacterReady(db, 'p', 2);
    await assert.rejects(assertReturnShopCharacterReady(db, 'p', 2, { forSubmit: true }), { code: 'return_shop_build_pending' });
    await assert.rejects(assertReturnShopSacrificeAllowed(db, 'p'), { code: 'return_shop_roll_protected' });
});
test('direito ja aplicado impede trocar roll mesmo quando entitlement consumido', async t => {
    const db = await fixture(t, { fulfillment_status: 'fulfilled', fulfilled_roll_number: 2 }, 'consumed');
    await assertReturnShopCharacterReady(db, 'p', 2, { forSubmit: true });
    await assert.rejects(assertReturnShopCharacterReady(db, 'p', 1), { code: 'return_shop_roll_locked' });
    await assert.rejects(assertReturnShopSacrificeAllowed(db, 'p'), { code: 'return_shop_roll_protected' });
});
test('entrega de personagem preparada pode seguir para materializacao no launch', async t => {
    const db = await fixture(t, { fulfillment_status: 'pending_character_fulfillment', items: [{ key: 'royalBox' }] });
    await assertReturnShopCharacterReady(db, 'p', 2, { forSubmit: true });
    await assertReturnShopLaunchReady(db, 'p');
});

test('rollback de outro roll continua permitido sem apagar roll comprado', async t => {
    const db = await fixture(t, { requires_roll_assignment:true, target_roll_number:2 });
    await assertReturnShopSacrificeAllowed(db,'p','mythic_launch_v1',3);
    await assert.rejects(assertReturnShopSacrificeAllowed(db,'p','mythic_launch_v1',2),{code:'return_shop_roll_protected'});
});
