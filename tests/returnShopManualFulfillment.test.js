'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const {fixture,imported,assigned,CAMPAIGN,service}=require('./fixtures/returnShopManualFixture');
const {fulfillReturnPointShopEconomicEntitlements}=require('../helpers/clover/returnPointShopFulfillmentService');
const {resetPlayer}=require('../helpers/clover/playerResetService');
const {getReturnPointTraitEntitlements}=require('../helpers/clover/returnPointShopTraitEntitlement');
test('complete build package preserves purchased fields independent of input order and retries without reapplying',async t=>{
    const db=await fixture(t);
    const effects=[{itemKey:'classe_nobreza'},{itemKey:'reino_clover'},{itemKey:'grimorio_clover_3f'},{itemKey:'traco_raro'}];
    for (const [index,manifest] of [effects,[...effects].reverse()].entries()) {
        const {importId}=await service.importManualReturnShopObligation(db,imported({operationKey:`import-${index}`,externalReference:`receipt-${index}`,sourceRowId:`row-${index}`,effects:manifest}));
        const request=assigned(importId,{operationKey:`assign-${index}`,targetRollNumber:index+1}); await service.assignManualReturnShopObligation(db,request);
        const fulfillment={...request,operationKey:`fulfill-${index}`}; await service.fulfillManualReturnShopBuild(db,fulfillment);
        const before=await db.get('SELECT * FROM clover_prereset_future_rolls WHERE player_id=? AND roll_number=?',['manual-owner',index+1]);
        assert.equal(before.kingdom_key,'clover'); assert.equal(before.social_class_key,'nobreza'); assert.equal(before.grimoire_key,'clover_3f');
        assert.equal((await getReturnPointTraitEntitlements(db,'manual-owner',index+1)).rare_aptitude,true);
        assert.equal((await service.fulfillManualReturnShopBuild(db,fulfillment)).duplicate,true);
        assert.deepEqual(await db.get('SELECT * FROM clover_prereset_future_rolls WHERE player_id=? AND roll_number=?',['manual-owner',index+1]),before);
    }
});
test('mid-package SQL failure rolls back roll effects, reservations, consumption and audit; retry succeeds',async t=>{
    const db=await fixture(t); const {importId}=await service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'classe_nobreza'},{itemKey:'reino_clover'},{itemKey:'grimorio_clover_3f'}]}));
    await service.assignManualReturnShopObligation(db,assigned(importId));
    const before=await db.all('SELECT * FROM clover_prereset_future_rolls');
    await db.exec("CREATE TRIGGER synthetic_failure BEFORE UPDATE OF grimoire_key ON clover_prereset_future_rolls WHEN NEW.social_class_key='nobreza' BEGIN SELECT RAISE(ABORT,'synthetic mid-package'); END");
    const request=assigned(importId,{operationKey:'fulfill'});
    await assert.rejects(service.fulfillManualReturnShopBuild(db,request),/synthetic mid-package/);
    assert.deepEqual(await db.all('SELECT * FROM clover_prereset_future_rolls'),before);
    assert.ok((await service.manualRows(db)).every(r=>r.status==='active'&&!service.metadata(r).buildApplied));
    assert.equal((await db.get("SELECT COUNT(*) n FROM clover_return_shop_manual_operations WHERE operation_type='fulfill'")).n,0);
    await db.exec('DROP TRIGGER synthetic_failure'); assert.equal((await service.fulfillManualReturnShopBuild(db,request)).ok,true);
});
test('incompatible composition remains pending with conflict audit and no silent kingdom adaptation',async t=>{
    const db=await fixture(t); const {importId}=await service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'reino_diamond'}]}));
    await service.assignManualReturnShopObligation(db,assigned(importId));
    await assert.rejects(service.fulfillManualReturnShopBuild(db,assigned(importId,{operationKey:'bad-build'})),{code:'manual_composition_conflict'});
    assert.equal((await db.get("SELECT kingdom_key FROM clover_prereset_future_rolls WHERE player_id='manual-owner' AND roll_number=1")).kingdom_key,'clover');
    assert.equal((await db.get("SELECT COUNT(*) n FROM clover_return_shop_manual_operations WHERE operation_type='conflict'")).n,1);
    assert.equal((await service.manualRows(db))[0].status,'active');
});
test('separate packages cannot silently erase a purchased class; malformed snapshots are rejected',async t=>{
    const db=await fixture(t);
    const a=await service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'classe_nobreza'}]}));
    await service.assignManualReturnShopObligation(db,assigned(a.importId));
    await service.fulfillManualReturnShopBuild(db,assigned(a.importId,{operationKey:'fulfill-class'}));
    const b=await service.importManualReturnShopObligation(db,imported({operationKey:'import-race',sourceRowId:'race',externalReference:'race',effects:[{itemKey:'raca_elfo'}]}));
    await service.assignManualReturnShopObligation(db,assigned(b.importId,{operationKey:'assign-race'}));
    await assert.rejects(service.fulfillManualReturnShopBuild(db,assigned(b.importId,{operationKey:'fulfill-race'})),{code:'manual_composition_conflict'});
    const roll=await db.get("SELECT race_key,social_class_key FROM clover_prereset_future_rolls WHERE player_id='manual-owner' AND roll_number=1");
    assert.equal(roll.race_key,'humano'); assert.equal(roll.social_class_key,'nobreza');
    const right=(await service.manualRows(db)).find(r=>r.manual_import_id===b.importId);
    const m=service.metadata(right); m.effectValue='bruxa';
    await db.run('UPDATE clover_prereset_entitlements SET metadata_json=? WHERE id=?',[JSON.stringify(m),right.id]);
    await assert.rejects(service.fulfillManualReturnShopBuild(db,assigned(b.importId,{operationKey:'tampered'})),{code:'manual_metadata_invalid'});
});
test('economic package survives modern reset, delivers atomically, and never credits twice',async t=>{
    const db=await fixture(t); await service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'yulls_5000'},{itemKey:'yulls_20000'}]}));
    const rights=await service.manualRows(db);
    assert.equal((await resetPlayer(db,{playerId:'manual-owner',reason:'Synthetic carryover',actorId:'test-admin',operationCode:'RS-MANUAL'})).ok,true);
    assert.deepEqual(await service.manualRows(db),rights);
    await db.exec("CREATE TRIGGER synthetic_credit_failure BEFORE UPDATE OF dinheiro ON jogadores WHEN NEW.dinheiro=25000 BEGIN SELECT RAISE(ABORT,'synthetic credit failure'); END");
    const fulfill=()=>fulfillReturnPointShopEconomicEntitlements(db,'manual-owner',{campaignKey:CAMPAIGN,actorId:'test-admin'});
    await assert.rejects(fulfill(),/synthetic credit failure/);
    assert.equal((await db.get("SELECT dinheiro FROM jogadores WHERE id='manual-owner'")).dinheiro,0);
    assert.ok((await service.manualRows(db)).every(r=>r.status==='active'));
    await db.exec('DROP TRIGGER synthetic_credit_failure'); assert.equal((await fulfill()).fulfilledCount,2);
    assert.equal((await fulfill()).fulfilledCount,0);
    assert.equal((await db.get("SELECT dinheiro FROM jogadores WHERE id='manual-owner'")).dinheiro,25000);
});
test('manual effects lacking a modern delivery provider remain pending and block economic package delivery',async t=>{
    const db=await fixture(t); await service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'eco_vida_passada'},{itemKey:'yulls_5000'}]}));
    await assert.rejects(fulfillReturnPointShopEconomicEntitlements(db,'manual-owner',{campaignKey:CAMPAIGN}),{code:'manual_delivery_provider_pending'});
    await assert.rejects(require('../helpers/clover/preResetFuturePromotionService').assertFutureLaunchReady(db,'manual-owner',CAMPAIGN),{code:'manual_delivery_provider_pending'});
    assert.ok((await service.manualRows(db)).every(r=>r.status==='active'));
    assert.equal((await db.get("SELECT dinheiro FROM jogadores WHERE id='manual-owner'")).dinheiro,0);
});
