'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture,imported,service} = require('./fixtures/returnShopManualFixture');
test('historical import creates only modern rights, no purchase/debit/gate change, and exact retry is idempotent',async t => {
    const db=await fixture(t);
    const tables=['clover_return_points_ledger','clover_prereset_purchases','clover_return_point_shop_gate'];
    const before=await Promise.all(tables.map(name=>db.all(`SELECT * FROM ${name}`)));
    const first=await service.importManualReturnShopObligation(db,imported());
    assert.equal(first.duplicate,false);
    assert.deepEqual(await service.importManualReturnShopObligation(db,imported()),{ok:true,duplicate:true,importId:first.importId});
    assert.deepEqual(await Promise.all(tables.map(name=>db.all(`SELECT * FROM ${name}`))),before);
    const row=await db.get('SELECT * FROM clover_return_shop_manual_imports WHERE id=?',[first.importId]);
    assert.equal(row.external_reference,'historical-receipt-one'); assert.equal(row.imported_by,'test-admin'); assert.equal(row.source_row_id,'row-one');
    const rights=await service.manualRows(db,'manual-owner'); assert.equal(rights.length,1); assert.equal(rights[0].purchase_id,null);
    await assert.rejects(db.run("UPDATE clover_return_shop_manual_imports SET source_row_id='changed' WHERE id=?",[first.importId]),/provenance immutable/);
    await assert.rejects(db.run("INSERT INTO clover_prereset_entitlements(player_id,entitlement_key,manual_import_id) VALUES('manual-other','bad-owner',?)",[first.importId]),/owner mismatch/);
    await assert.rejects(db.run('DELETE FROM clover_prereset_entitlements WHERE manual_import_id=?',[first.importId]),/must be preserved/);
});
test('duplicate provenance is rejected under a new key; changed retry and malformed manifest are rejected',async t => {
    const db=await fixture(t); await service.importManualReturnShopObligation(db,imported());
    await assert.rejects(service.importManualReturnShopObligation(db,imported({operationKey:'new-key'})),{code:'manual_duplicate_obligation'});
    await assert.rejects(service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'yulls_20000'}]})),{code:'manual_idempotency_conflict'});
    await assert.rejects(service.importManualReturnShopObligation(db,imported({sourceRowId:''})),{code:'manual_invalid_argument'});
    await assert.rejects(service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'legacy-unknown'}]})),{code:'manual_unknown_catalog_item'});
    await assert.rejects(service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'raca_elfo',quantity:2}]})),{code:'manual_invalid_quantity'});
});
