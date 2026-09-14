'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,imported,service,CAMPAIGN}=require('./fixtures/returnShopManualFixture');
const {fulfillReturnPointShopEconomicEntitlements:fulfill}=require('../helpers/clover/returnPointShopFulfillmentService');
const products=['caixa_comum','caixa_rara','ticket_feitico','cupom_prioridade_feitico'];
test('four canonical inventory rights deliver during PRE_RESET, with exact templates/binding/provenance and concurrent retry',async t=>{
 const db=await fixture(t);await service.importManualReturnShopObligation(db,imported({effects:products.map(itemKey=>({itemKey}))}));
 await service.assertManualLaunchReady(db,'manual-owner',CAMPAIGN);
 const results=await require('../helpers/clover/lifecyclePolicy').runWithLifecycleContext({env:{PRE_RESET_RETURN_ENABLED:'true'}},()=>Promise.all([fulfill(db,'manual-owner',{campaignKey:CAMPAIGN}),fulfill(db,'manual-owner',{campaignKey:CAMPAIGN})]));
 assert.equal(results.reduce((n,r)=>n+r.fulfilledCount,0),4);
 const items=await db.all("SELECT template_key,quantity,bound,transferable,source,related_id FROM clover_inventory_items WHERE player_id='manual-owner'");
 assert.deepEqual(items.map(i=>i.template_key).sort(),['box_simple_v1','box_rare_v1','ticket_feitico','cupom_prioridade'].sort());
 assert.ok(items.every(i=>i.quantity===1&&i.bound===1&&i.transferable===0&&i.source==='return_point_shop_fulfillment'&&i.related_id.startsWith('return-shop:entitlement:')));
 assert.ok((await service.manualRows(db)).every(r=>r.status==='consumed'));
 assert.equal((await fulfill(db,'manual-owner',{campaignKey:CAMPAIGN})).fulfilledCount,0);
});
test('consume failure rolls back inventory/history and all package credits; retry succeeds',async t=>{
 const db=await fixture(t);await service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'caixa_comum'},{itemKey:'yulls_5000'}]}));
 await db.exec("CREATE TRIGGER synthetic_consume_failure BEFORE UPDATE OF status ON clover_prereset_entitlements WHEN NEW.status='consumed' BEGIN SELECT RAISE(ABORT,'consume failure'); END");
 await assert.rejects(fulfill(db,'manual-owner',{campaignKey:CAMPAIGN}),/consume failure/);
 assert.equal((await db.get('SELECT COUNT(*) n FROM clover_inventory_items')).n,0);
 assert.equal((await db.get('SELECT COUNT(*) n FROM clover_inventory_item_history')).n,0);
 assert.ok((await service.manualRows(db)).every(r=>r.status==='active'));
 await db.exec('DROP TRIGGER synthetic_consume_failure');assert.equal((await fulfill(db,'manual-owner',{campaignKey:CAMPAIGN})).fulfilledCount,2);
});
test('normal purchased right uses the same inventory provider without a second debit',async t=>{
 const db=await fixture(t);
 for(let n=0;n<14;n++) { const id='synthetic-keep-'+n; await db.run("INSERT INTO jogadores(id,nome,ficha_status) VALUES (?,'Synthetic','aprovada')",[id]); await db.run("INSERT INTO clover_prereset_launch_players(campaign_key,player_id,roster_revision,outcome,status) VALUES (?,?,1,'keep','pending')",[CAMPAIGN,id]); await db.run("INSERT INTO clover_prereset_launch_keep_roster(campaign_key,player_id,roster_revision,added_by) VALUES (?,?,1,'test')",[CAMPAIGN,id]); }
 await require('../helpers/clover/returnPointShopGateService').openReturnPointShop(db,'test-admin');
 const points=require('../helpers/clover/returnPointsService');
 await points.creditReturnPoints(db,'manual-owner',150,{operationKey:'normal-ticket-credit',source:'fixture',reason:'Synthetic',createdBy:'test'});
 const debit=await points.debitReturnPoints(db,'manual-owner',150,{operationKey:'normal-ticket-debit',source:'return_point_shop',reason:'Synthetic',createdBy:'test'});
 const purchase=await db.run("INSERT INTO clover_prereset_purchases(player_id,idempotency_key,catalog_item_key,entitlement_key,price_return_points,return_points_ledger_id,metadata_json) VALUES ('manual-owner','normal-ticket','ticket_feitico','normal-ticket',150,?,'{}')",[debit.ledgerId]);
 await db.run("INSERT INTO clover_prereset_entitlements(player_id,entitlement_key,purchase_id,metadata_json) VALUES ('manual-owner','normal-ticket',?,?)",[purchase.lastID,JSON.stringify({effectKind:'future_item',effectValue:'ticket_feitico',quantity:1})]);
 assert.equal((await fulfill(db,'manual-owner',{campaignKey:CAMPAIGN})).fulfilledCount,1);
 assert.equal((await fulfill(db,'manual-owner',{campaignKey:CAMPAIGN})).fulfilledCount,0);
 assert.equal((await db.get('SELECT COUNT(*) n FROM clover_prereset_purchases')).n,1);
 assert.equal(await points.getReturnPointsBalance(db,'manual-owner'),0);
 assert.equal((await db.get("SELECT COUNT(*) n FROM clover_return_points_ledger WHERE player_id='manual-owner' AND entry_kind='debit'")).n,1);
});
