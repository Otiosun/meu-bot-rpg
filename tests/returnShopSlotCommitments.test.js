'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { countReturnShopSlotCommitments } = require('../helpers/clover/returnShopSlotCommitments');

test('compras manuais reservam vagas antes da escolha, sem contar entrega consumida ou outra campanha', async t => {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    t.after(() => db.close());
    await db.exec(`CREATE TABLE clover_prereset_purchases (id INTEGER PRIMARY KEY,status TEXT);
        CREATE TABLE clover_prereset_entitlements (id INTEGER PRIMARY KEY,purchase_id INTEGER,status TEXT,metadata_json TEXT);
        INSERT INTO clover_prereset_purchases VALUES (1,'completed'),(2,'completed'),(3,'completed'),(4,'cancelled');`);
    const meta = (campaign, items) => JSON.stringify({ reset_cycle_key: campaign, items });
    const item = [{ key: 'polishedDiamond', quantity: 1 }];
    await db.run('INSERT INTO clover_prereset_entitlements VALUES (1,1,?,?)', ['active',meta('mythic_launch_v1',item)]);
    await db.run('INSERT INTO clover_prereset_entitlements VALUES (2,2,?,?)', ['consumed',meta('mythic_launch_v1',item)]);
    await db.run('INSERT INTO clover_prereset_entitlements VALUES (3,3,?,?)', ['active',meta('other',item)]);
    await db.run('INSERT INTO clover_prereset_entitlements VALUES (4,4,?,?)', ['active',meta('mythic_launch_v1',item)]);
    assert.equal(await countReturnShopSlotCommitments(db, 'grimoire', 'diamond_4f', 'mythic_launch_v1'), 1);
    assert.equal(await countReturnShopSlotCommitments(db, 'grimoire', 'diamond_4f', 'mythic_launch_v1', { excludeEntitlementId: 1 }), 0);
    assert.equal(await countReturnShopSlotCommitments(db, 'race', 'elfo', 'mythic_launch_v1'), 0);
});

test('banco sem loja manual continua usando apenas reservas normais', async t => {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    t.after(() => db.close());
    assert.equal(await countReturnShopSlotCommitments(db, 'grimoire', 'clover_4f', 'mythic_launch_v1'), 0);
});
