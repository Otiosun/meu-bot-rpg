'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { applyReturnShopCharacterFulfillment } = require('../helpers/clover/preresetReturnShopCharacterFulfillmentService');

async function setup(t) {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    t.after(() => db.close());
    await db.exec(`
        CREATE TABLE jogadores (id TEXT PRIMARY KEY, personagem_nome TEXT DEFAULT '-', dinheiro INTEGER DEFAULT 0);
        CREATE TABLE clover_prereset_purchases (
            id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
            catalog_item_key TEXT NOT NULL, entitlement_key TEXT NOT NULL, price_return_points INTEGER NOT NULL,
            return_points_ledger_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'completed',
            metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE clover_prereset_entitlements (
            id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL, entitlement_key TEXT NOT NULL,
            purchase_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP, consumed_at TEXT
        );
        INSERT INTO jogadores(id, personagem_nome) VALUES ('player@lid', 'Novo');
    `);
    return db;
}

async function addPackage(db, key, items) {
    const metadata = JSON.stringify({
        items,
        requires_roll_assignment: false,
        fulfillment_status: 'pending_character_fulfillment',
    });
    const purchase = await db.run(`INSERT INTO clover_prereset_purchases
        (player_id,idempotency_key,catalog_item_key,entitlement_key,price_return_points,return_points_ledger_id,metadata_json)
        VALUES ('player@lid',?,'return_shop_normal_package',?,100,1,?)`, [key, `return_shop_package:${key}`, metadata]);
    await db.run(`INSERT INTO clover_prereset_entitlements(player_id,entitlement_key,purchase_id,metadata_json)
        VALUES ('player@lid',?,?,?)`, [`return_shop_package:${key}`, purchase.lastID, metadata]);
}

test('materializa recursos conhecidos uma vez e preserva direitos sem definicao canonica', async t => {
    const db = await setup(t);
    await addPackage(db, 'mixed', [
        { key: 'rareBox', quantity: 2 },
        { key: 'spellTicket', quantity: 1 },
        { key: 'ph', quantity: 3 },
        { key: 'yulls20k', quantity: 1 },
        { key: 'royalBox', quantity: 2 },
        { key: 'crystalHeart', quantity: 1 },
    ]);

    const first = await applyReturnShopCharacterFulfillment(db, { playerId: 'player@lid', actorId: 'test' });
    assert.equal(first.fulfilled.length, 1);
    assert.equal((await db.get("SELECT quantity FROM clover_inventory_items WHERE template_key='box_rare_v1'")).quantity, 2);
    assert.equal((await db.get("SELECT quantity FROM clover_inventory_items WHERE template_key='ticket_feitico'")).quantity, 1);
    assert.equal((await db.get('SELECT ph_available FROM clover_character_stats WHERE player_id=?', ['player@lid'])).ph_available, 18);
    assert.equal((await db.get('SELECT dinheiro FROM jogadores WHERE id=?', ['player@lid'])).dinheiro, 20000);
    const entitlement = await db.get('SELECT * FROM clover_prereset_entitlements');
    assert.equal(entitlement.status, 'active');
    assert.deepEqual(JSON.parse(entitlement.metadata_json).active_rights.map(row => row.key), ['royalBox', 'crystalHeart']);

    const second = await applyReturnShopCharacterFulfillment(db, { playerId: 'player@lid', actorId: 'test' });
    assert.equal(second.fulfilled.length, 0);
    assert.equal((await db.get("SELECT quantity FROM clover_inventory_items WHERE template_key='box_rare_v1'")).quantity, 2);
    assert.equal((await db.get('SELECT dinheiro FROM jogadores WHERE id=?', ['player@lid'])).dinheiro, 20000);
});

test('salvamento de inventario so e concluido apos preservacao do launch', async t => {
    const db = await setup(t);
    await addPackage(db, 'save', [{ key: 'inventorySave', quantity: 1 }]);
    await applyReturnShopCharacterFulfillment(db, { playerId: 'player@lid' });
    let metadata = JSON.parse((await db.get('SELECT metadata_json FROM clover_prereset_entitlements')).metadata_json);
    assert.equal(metadata.active_rights[0].reason, 'awaiting_launch_inventory_preservation');

    await db.run("UPDATE clover_prereset_entitlements SET metadata_json=json_set(metadata_json,'$.fulfillment_status','pending_character_fulfillment')");
    await applyReturnShopCharacterFulfillment(db, { playerId: 'player@lid', inventoryPreservationApplied: true });
    const entitlement = await db.get('SELECT * FROM clover_prereset_entitlements');
    metadata = JSON.parse(entitlement.metadata_json);
    assert.equal(entitlement.status, 'consumed');
    assert.equal(metadata.character_fulfillment_result.items[0].disposition, 'inventory_preserved');
});
