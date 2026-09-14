'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const {fixture,imported,assigned,service}=require('./fixtures/returnShopManualFixture');
test('pending package assignment enforces owner, supports pre-consumption reassignment, audit and retry',async t=>{
    const db=await fixture(t); const {importId}=await service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'classe_nobreza'}]}));
    await assert.rejects(service.assignManualReturnShopObligation(db,assigned(importId,{playerId:'manual-other'})),{code:'manual_wrong_owner'});
    assert.equal((await service.assignManualReturnShopObligation(db,assigned(importId))).duplicate,false);
    assert.equal((await service.assignManualReturnShopObligation(db,assigned(importId))).duplicate,true);
    await service.assignManualReturnShopObligation(db,assigned(importId,{operationKey:'assign-two',targetRollNumber:2}));
    const history=await db.all("SELECT details_json FROM clover_return_shop_manual_operations WHERE operation_type='assign' ORDER BY created_at,operation_key");
    assert.equal(history.length,2); assert.equal(JSON.parse(history[1].details_json).after,2);
    await service.fulfillManualReturnShopBuild(db,assigned(importId,{operationKey:'fulfill-two',targetRollNumber:2}));
    await assert.rejects(service.assignManualReturnShopObligation(db,assigned(importId,{operationKey:'assign-three'})),{code:'manual_already_consumed'});
});
test('assignment rejects duplicate effect ownership and wrong campaign/target',async t=>{
    const db=await fixture(t);
    const a=await service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'classe_nobreza'}]}));
    const b=await service.importManualReturnShopObligation(db,imported({operationKey:'import-two',sourceRowId:'two',externalReference:'two',effects:[{itemKey:'classe_realeza'}]}));
    await service.assignManualReturnShopObligation(db,assigned(a.importId));
    await assert.rejects(service.assignManualReturnShopObligation(db,assigned(b.importId,{operationKey:'assign-b'})),{code:'manual_target_exclusive_conflict'});
    await assert.rejects(service.assignManualReturnShopObligation(db,assigned(b.importId,{operationKey:'wrong-target',targetRollNumber:9})),{code:'manual_target_not_found'});
    await assert.rejects(service.assignManualReturnShopObligation(db,assigned(b.importId,{operationKey:'wrong-campaign',campaignKey:'other'})),{code:'manual_target_not_found'});
});
test('normal shop cannot debit again to overwrite an assigned historical field',async t=>{
    const db=await fixture(t); const {importId}=await service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'classe_nobreza'}]}));
    await service.assignManualReturnShopObligation(db,assigned(importId));
    const {CAMPAIGN}=require('./fixtures/returnShopManualFixture');
    await db.run(`INSERT INTO clover_return_point_shop_gate(campaign_key,status,required_keep_count,roster_revision,roster_hash,keep_count_at_open,opened_by,opened_at)
        VALUES (?,'open',14,1,'synthetic',14,'test-admin',CURRENT_TIMESTAMP)`,[CAMPAIGN]);
    await db.run(`INSERT INTO clover_return_point_shop_eligible(campaign_key,player_id,roster_revision,roster_hash,outcome,captured_by)
        VALUES (?,'manual-owner',1,'synthetic','reset','test-admin')`,[CAMPAIGN]);
    await require('../helpers/clover/returnPointsService').creditReturnPoints(db,'manual-owner',1000,{operationKey:'fund',source:'test',reason:'Synthetic funds',createdBy:'test-admin'});
    const before=await db.all('SELECT * FROM clover_return_points_ledger');
    await assert.rejects(require('../helpers/clover/returnPointShopService').purchaseReturnPointShopItem(db,'manual-owner',{itemKey:'classe_realeza',targetRollNumber:1,idempotencyKey:'normal-overwrite'}),{code:'manual_target_exclusive_conflict'});
    assert.deepEqual(await db.all('SELECT * FROM clover_return_points_ledger'),before);
    assert.equal((await db.get('SELECT COUNT(*) n FROM clover_prereset_purchases')).n,0);
    assert.equal(require('../helpers/clover/returnPointShopHttp').statusFor({code:'manual_target_exclusive_conflict'}),409);
});
