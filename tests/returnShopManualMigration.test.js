'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const {open}=require('sqlite'); const sqlite3=require('sqlite3');
const {RETURN_POINT_SHOP_PURCHASE_MIGRATION}=require('../helpers/clover/returnPointShopPurchaseMigration');
const {RETURN_POINT_SHOP_MANUAL_MIGRATION,inspectManualSchema}=require('../helpers/clover/returnPointShopManualMigration');
const {withImmediateTransaction}=require('../helpers/clover/sqliteImmediateTransactionService');
test('0044 preserves modern purchased rights, consumed state, IDs, sequence and foreign keys; repeat is exact',async t=>{
    const db=await open({filename:':memory:',driver:sqlite3.Database}); t.after(()=>db.close());
    await db.exec("PRAGMA foreign_keys=ON; CREATE TABLE jogadores(id TEXT PRIMARY KEY); CREATE TABLE clover_return_points_ledger(id INTEGER PRIMARY KEY); INSERT INTO jogadores VALUES('owner'); INSERT INTO clover_return_points_ledger VALUES(1)");
    await RETURN_POINT_SHOP_PURCHASE_MIGRATION.up(db);
    await db.exec(`INSERT INTO clover_prereset_purchases(player_id,idempotency_key,catalog_item_key,entitlement_key,price_return_points,return_points_ledger_id)
        VALUES('owner','old-buy','yulls_5000','old-right',10,1);
        INSERT INTO clover_prereset_entitlements(id,player_id,entitlement_key,purchase_id,status,metadata_json,consumed_at)
        VALUES(70,'owner','old-right',1,'consumed','{"effectKind":"future_yulls"}','2026-07-13');
        UPDATE sqlite_sequence SET seq=900 WHERE name='clover_prereset_entitlements'`);
    const before=await db.get('SELECT * FROM clover_prereset_entitlements');
    await withImmediateTransaction(db,()=>RETURN_POINT_SHOP_MANUAL_MIGRATION.up(db));
    const after=await db.get('SELECT * FROM clover_prereset_entitlements'); delete after.manual_import_id;
    assert.deepEqual(after,before); assert.equal((await db.get("SELECT seq FROM sqlite_sequence WHERE name='clover_prereset_entitlements'")).seq,900);
    assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]); assert.equal(await inspectManualSchema(db),true);
    await withImmediateTransaction(db,()=>RETURN_POINT_SHOP_MANUAL_MIGRATION.up(db));
    await assert.rejects(db.run("INSERT INTO clover_prereset_entitlements(player_id,entitlement_key) VALUES('owner','invalid')"),/CHECK constraint/);
});
