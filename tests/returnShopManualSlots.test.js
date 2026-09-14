'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const {fixture,imported,assigned,CAMPAIGN,service}=require('./fixtures/returnShopManualFixture');
const {getFutureSlotAvailability,holdFutureSlot}=require('../helpers/clover/preResetFutureSlotService');
const {withImmediateTransaction}=require('../helpers/clover/sqliteImmediateTransactionService');
const {openCloverDatabase}=require('../helpers/clover/databaseConnection');
test('pending manual commitment counts once, equivalent future hold and materialization do not double count',async t=>{
    const db=await fixture(t); const {importId}=await service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'raca_elfo'}]}));
    let availability=await getFutureSlotAvailability(db,'race','elfo',CAMPAIGN);
    assert.equal(availability.manualCommitted,1); assert.equal(availability.usedCount,1);
    await service.assignManualReturnShopObligation(db,assigned(importId));
    const hold=await withImmediateTransaction(db,()=>holdFutureSlot(db,{playerId:'manual-owner',rollNumber:1,category:'race',optionKey:'elfo',campaignKey:CAMPAIGN}));
    assert.equal(hold.ok,true);
    availability=await getFutureSlotAvailability(db,'race','elfo',CAMPAIGN); assert.equal(availability.manualCommitted,0); assert.equal(availability.usedCount,1);
    await service.fulfillManualReturnShopBuild(db,assigned(importId,{operationKey:'fulfill'}));
    availability=await getFutureSlotAvailability(db,'race','elfo',CAMPAIGN); assert.equal(availability.usedCount,1);
    await db.run("UPDATE clover_prereset_future_slot_reservations SET status='consumed' WHERE player_id='manual-owner'");
    assert.equal(await service.countManualSlotCommitments(db,'race','elfo',CAMPAIGN),0);
});
test('KEEP plus modern future holds retain capacity accounting and concurrent manual imports cannot oversell last slot',async t=>{
    const db=await fixture(t);
    await db.run("UPDATE clover_prereset_launch_players SET outcome='keep' WHERE player_id='manual-other'");
    await db.run("UPDATE jogadores SET raca='Elfo' WHERE id='manual-other'");
    for(let i=0;i<4;i++) await db.run(`INSERT INTO clover_prereset_future_slot_reservations(campaign_key,player_id,roll_number,category,option_key,status,source)
        VALUES (?,?,1,'race','elfo','held','synthetic')`,[CAMPAIGN,`existing-${i}`]);
    const availability=await getFutureSlotAvailability(db,'race','elfo',CAMPAIGN); assert.equal(availability.keepUsed,1); assert.equal(availability.futureHeld,4);
    const filename=(await db.get('PRAGMA database_list')).file;
    const other=await openCloverDatabase({filename,busyTimeoutMs:10000});
    const attempts=await Promise.allSettled([
        service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'raca_elfo'}]})),
        service.importManualReturnShopObligation(other,imported({operationKey:'import-two',externalReference:'two',sourceRowId:'two',effects:[{itemKey:'raca_elfo'}]})),
    ]);
    assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(attempts.find(r=>r.status==='rejected').reason.code,'manual_slot_full');
    assert.equal((await getFutureSlotAvailability(db,'race','elfo',CAMPAIGN)).usedCount,availability.capacity);
    await other.close();
});
test('an equivalent KEEP slot represents the same historical obligation once without consuming the pending right',async t=>{
    const db=await fixture(t);
    await db.run("UPDATE clover_prereset_launch_players SET outcome='keep' WHERE player_id='manual-owner'");
    await db.run("UPDATE jogadores SET raca='Elfo' WHERE id='manual-owner'");
    await service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'raca_elfo'}]}));
    const available=await getFutureSlotAvailability(db,'race','elfo',CAMPAIGN);
    assert.equal(available.keepUsed,1); assert.equal(available.manualCommitted,0); assert.equal(available.usedCount,1);
    assert.equal((await service.manualRows(db,'manual-owner'))[0].status,'active');
});
