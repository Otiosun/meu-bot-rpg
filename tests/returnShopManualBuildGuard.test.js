'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const {fixture,imported,assigned,CAMPAIGN,service}=require('./fixtures/returnShopManualFixture');
const {rollbackFutureRoll,createAndStoreFutureSacrificeRoll}=require('../helpers/clover/preResetFutureRollService');
const {applyFutureCharacterMutation}=require('../helpers/clover/preResetCharacterService');
test('destructive roll rollback and sacrifice cannot escape assigned obligations; pending submit and consumed build switch are blocked',async t=>{
    const db=await fixture(t); const {importId}=await service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'classe_nobreza'}]}));
    await service.assignManualReturnShopObligation(db,assigned(importId));
    await assert.rejects(rollbackFutureRoll(db,'manual-owner',1,CAMPAIGN),{code:'manual_roll_protected'});
    await assert.rejects(createAndStoreFutureSacrificeRoll(db,'manual-owner',CAMPAIGN),{code:'manual_roll_protected'});
    await assert.rejects(service.assertManualBuildBoundary(db,'manual-owner',{rollNumber:1,submit:true}),{code:'manual_build_pending'});
    await service.fulfillManualReturnShopBuild(db,assigned(importId,{operationKey:'fulfill'}));
    await assert.rejects(applyFutureCharacterMutation(db,'manual-owner','test-admin',{operationType:'create',operationKey:'switch-character',expectedRevision:0,draft:{rollNumber:2}}),{code:'manual_roll_locked'});
    assert.equal((await db.get("SELECT COUNT(*) n FROM clover_prereset_future_rolls WHERE player_id='manual-owner'")).n,2);
    await db.run("UPDATE clover_prereset_launch_players SET status='completed' WHERE player_id='manual-owner'");
    await service.assertManualBuildBoundary(db,'manual-owner',{rollNumber:2,submit:true,destructive:true});
});
