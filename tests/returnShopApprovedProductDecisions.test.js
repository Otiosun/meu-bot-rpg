'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,imported,assigned,service,CAMPAIGN}=require('./fixtures/returnShopManualFixture');
const {getReturnPointShopItem}=require('../helpers/clover/returnPointShopCatalog');
const {getConfigOption}=require('../helpers/clover/configLoader');
const {fulfillReturnPointShopEconomicEntitlements:fulfill}=require('../helpers/clover/returnPointShopFulfillmentService');
const inventory=require('../helpers/clover/inventoryService');
const workflow=require('../helpers/clover/returnShopCustomItemService');
const mapping=[['spade_1','spade_3f'],['spade_2','spade_4f'],['heart_comum','heart_3f'],['heart_duplo','heart_4f'],['diamond_comum','diamond_3f'],['diamond_lapidado','diamond_4f']];
for(const [source,destination] of mapping)test('approved grimoire '+source+' uses modern identity/capacity, one consumed right and exact retry',async t=>{
 const db=await fixture(t);const kingdom=destination.split('_')[0];
 assert.equal(getReturnPointShopItem('grimorio_'+source).effectValue,destination);
 const {importId}=await service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'reino_'+kingdom},{itemKey:'grimorio_'+source}]}));
 await service.assignManualReturnShopObligation(db,assigned(importId));
 const request=assigned(importId,{operationKey:'deliver-build'});await service.fulfillManualReturnShopBuild(db,request);
 const roll=await db.get("SELECT * FROM clover_prereset_future_rolls WHERE player_id='manual-owner' AND roll_number=1");const option=getConfigOption('grimoires',destination);
 assert.equal(roll.grimoire_key,destination);assert.equal(roll.grimoire,option.name);assert.equal(roll.grimoire_rank,option.rank);assert.equal(roll.grimoire_symbol,option.symbol);
 assert.ok((await service.manualRows(db)).every(r=>r.status==='consumed'));
 assert.equal((await service.fulfillManualReturnShopBuild(db,request)).duplicate,true);
 // Historical snapshots use only the explicitly approved alias at the modern writer.
 const old={...getReturnPointShopItem('grimorio_'+source),effectValue:source};
 await require('../helpers/clover/returnPointShopService').applyRollEffect(db,'manual-owner',old,roll);
 assert.equal((await db.get("SELECT grimoire_key FROM clover_prereset_future_rolls WHERE player_id='manual-owner' AND roll_number=1")).grimoire_key,destination);
});
test('Royal is a closed bound box without loot/action; only canonical boxes survive reset',async t=>{
 const db=await fixture(t);await service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'caixa_real'}]}));
 await fulfill(db,'manual-owner',{campaignKey:CAMPAIGN});
 const royal=await db.get("SELECT * FROM clover_inventory_items WHERE player_id='manual-owner' AND template_key='box_royal_v1'");assert.equal(royal.quantity,1);assert.equal(royal.bound,1);
 assert.equal(require('../helpers/clover/itemUseCatalog').getItemUseAction(royal),null);
 await assert.rejects(require('../helpers/clover/boxService').openBox(db,'manual-owner','box_royal_v1',{idempotencyKey:'royal-open'}),{code:'box_loot_table_pending'});
 await inventory.addCatalogItem(db,'manual-owner','pocao_cura_basica',1,{source:'fixture'});
 const nonbox=await db.get("SELECT * FROM clover_inventory_items WHERE player_id='manual-owner' AND template_key='pocao_cura_basica'");
 await db.run("INSERT INTO clover_prereset_launch_inventory_preservations(campaign_key,player_id,inventory_item_id,template_key,snapshot_json,snapshot_hash) VALUES (?,?,?,?,?,?)",[CAMPAIGN,'manual-owner',nonbox.id,nonbox.template_key,JSON.stringify(nonbox),'synthetic-old-invalid-scope']);
 const launch=require('../helpers/clover/preResetLaunchService');const rows=await launch.registerBoxPreservations(db,CAMPAIGN,'manual-owner');assert.deepEqual(rows.map(r=>r.template_key),['box_royal_v1']);assert.equal((await db.get('SELECT status FROM clover_prereset_launch_inventory_preservations WHERE inventory_item_id=?',[nonbox.id])).status,'released');
 await db.run("UPDATE clover_prereset_launch_players SET status='applying' WHERE player_id='manual-owner'");
 const reset=await require('../helpers/clover/playerResetService').resetPlayer(db,{playerId:'manual-owner',actorId:'test',operationCode:'ROYAL-TEST',reason:'Synthetic launch'});assert.equal(reset.ok,true);
 assert.deepEqual((await db.all("SELECT template_key FROM clover_inventory_items WHERE player_id='manual-owner'")).map(r=>r.template_key),['box_royal_v1']);
 assert.equal((await fulfill(db,'manual-owner',{campaignKey:CAMPAIGN})).fulfilledCount,0);
});
async function customFixture(t){
 const db=await fixture(t);await service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'item_magico_personalizado'}]}));await fulfill(db,'manual-owner',{campaignKey:CAMPAIGN});
 const r=await db.get('SELECT * FROM clover_return_shop_custom_requests');
 await require('../helpers/clover/canonicalRoleGrantSchema').ensureCanonicalRoleGrantSchema(db);
 await db.run("INSERT INTO clover_role_grants(subject_id,role_key,scope_type,scope_key,status,valid_from,granted_by,origin_type,origin_ref) VALUES ('admin@lid','admin','global','*','active','2000-01-01','owner@lid','fixture','approved-product-test')");
 await inventory.ensureInventoryV1(db);
 await db.run("INSERT INTO clover_item_templates(template_key,catalog_version,item_name,description,category,kind,base_price,default_quality,stackable,transferable,active,is_custom) VALUES ('custom_approved_test',1,'Approved Item','Explicit synthetic approved specification','item_magico','item_magico',0,'comum',1,0,1,1)");
 return {db,id:r.entitlement_id};
}
test('custom right queues without consumption; owner submits, canonical ADM approves, post-launch concurrent delivery consumes exactly once',async t=>{
 const {db,id}=await customFixture(t);assert.equal((await service.manualRows(db))[0].status,'active');
 await assert.rejects(workflow.submitRequest(db,'manual-other',id,'Specification'),{code:'custom_item_wrong_owner'});
 await assert.rejects(workflow.listRequests(db,'normal@lid'),{code:'custom_item_admin_required'});
 await workflow.submitRequest(db,'manual-owner',id,'Explicit item specification');
 await assert.rejects(workflow.approveRequest(db,'normal@lid',id,'custom_approved_test'),{code:'custom_item_admin_required'});
 await workflow.approveRequest(db,'admin@lid',id,'custom_approved_test');assert.equal((await service.manualRows(db))[0].status,'active');
 await assert.rejects(workflow.deliverRequest(db,'admin@lid',id),{code:'custom_item_launch_pending'});
 await db.run("UPDATE clover_prereset_launch_players SET status='completed' WHERE player_id='manual-owner'");
 const results=await Promise.all([workflow.deliverRequest(db,'admin@lid',id),workflow.deliverRequest(db,'admin@lid',id)]);assert.equal(results.filter(r=>r.duplicate).length,1);
 assert.equal((await db.get("SELECT COUNT(*) n FROM clover_inventory_items WHERE source='return_shop_custom_item'")).n,1);
 const r=await db.get('SELECT * FROM clover_return_shop_custom_requests');assert.equal(r.status,'delivered');assert.equal(r.approved_by,'admin@lid');assert.equal(r.delivered_by,'admin@lid');assert.ok(r.inventory_item_id);assert.equal((await service.manualRows(db))[0].status,'consumed');
 await assert.rejects(db.run("DELETE FROM clover_return_shop_custom_requests WHERE entitlement_id=?",[id]),/append_only/);
});
test('custom changed template and failed consume never grant; unchanged retry delivers with audit',async t=>{
 const {db,id}=await customFixture(t);await workflow.submitRequest(db,'manual-owner',id,'Specification');await workflow.approveRequest(db,'admin@lid',id,'custom_approved_test');await db.run("UPDATE clover_prereset_launch_players SET status='completed' WHERE player_id='manual-owner'");
 await db.run("UPDATE clover_item_templates SET description='Changed' WHERE template_key='custom_approved_test'");await assert.rejects(workflow.deliverRequest(db,'admin@lid',id),{code:'custom_item_template_changed'});
 await db.run("UPDATE clover_item_templates SET description='Explicit synthetic approved specification' WHERE template_key='custom_approved_test'");
 await db.exec("CREATE TRIGGER synthetic_custom_failure BEFORE UPDATE OF status ON clover_prereset_entitlements WHEN NEW.status='consumed' BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END");await assert.rejects(workflow.deliverRequest(db,'admin@lid',id),/Synthetic failure/);
 assert.equal((await db.get('SELECT COUNT(*) n FROM clover_inventory_items')).n,0);assert.equal((await db.get('SELECT COUNT(*) n FROM clover_inventory_item_history')).n,0);assert.equal((await service.manualRows(db))[0].status,'active');
 await db.exec('DROP TRIGGER synthetic_custom_failure');assert.equal((await workflow.deliverRequest(db,'admin@lid',id)).status,'delivered');
});

test('unapproved Artesao identity remains active/pending without any build mutation',async t=>{
 const db=await fixture(t);const {importId}=await service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'classe_artesao'}]}));await service.assignManualReturnShopObligation(db,assigned(importId));const before=await db.get("SELECT * FROM clover_prereset_future_rolls WHERE player_id='manual-owner' AND roll_number=1");
 await assert.rejects(service.fulfillManualReturnShopBuild(db,assigned(importId,{operationKey:'blocked-class'})),{code:'catalog_identity_pending'});assert.deepEqual(await db.get("SELECT * FROM clover_prereset_future_rolls WHERE player_id='manual-owner' AND roll_number=1"),before);assert.equal((await service.manualRows(db))[0].status,'active');
});
test('specials block mixed package and PH is never initialized before promotion',async t=>{
 const db=await fixture(t);await service.importManualReturnShopObligation(db,imported({effects:['ticket_reliquia','eco_vida_passada','coracao_cristal','ryuga','gintetsu','surtr','capibara','ph_1'].map(itemKey=>({itemKey}))}));const before=await db.all('SELECT * FROM clover_ph_ledger');await assert.rejects(fulfill(db,'manual-owner',{campaignKey:CAMPAIGN}),{code:'manual_delivery_provider_pending'});assert.deepEqual(await db.all('SELECT * FROM clover_ph_ledger'),before);assert.ok((await service.manualRows(db)).every(r=>r.status==='active'));
});

test('Miseravel remains explicitly blocked without canonical identity fallback',async t=>{
 const db=await fixture(t);const before=await db.get("SELECT * FROM clover_prereset_future_rolls WHERE player_id='manual-owner' AND roll_number=1");
 await assert.rejects(require('../helpers/clover/returnPointShopService').applyRollEffect(db,'manual-owner',getReturnPointShopItem('classe_miseravel'),before),{code:'catalog_identity_pending'});
 assert.deepEqual(await db.get("SELECT * FROM clover_prereset_future_rolls WHERE player_id='manual-owner' AND roll_number=1"),before);
 assert.equal(getReturnPointShopItem('classe_miseravel').purchasable,false);
});
test('custom migration is repeatable and rejects mismatched existing shape',async t=>{
 const db=await fixture(t);const migration=require('../helpers/clover/returnShopCustomItemMigration').RETURN_SHOP_CUSTOM_ITEM_MIGRATION;await migration.up(db);await db.exec('DROP TRIGGER return_custom_identity');await db.exec('CREATE TRIGGER return_custom_identity AFTER UPDATE ON clover_return_shop_custom_requests BEGIN SELECT 1; END');await assert.rejects(migration.up(db),{code:'custom_item_schema_mismatch'});
});

test('canonical ADM creates only a submitted right template, with exact creation retry and separate approval',async t=>{
 const {db,id}=await customFixture(t);await workflow.submitRequest(db,'manual-owner',id,'Approved specification');const spec={templateKey:'linked_right_test',itemName:'Requested Item',description:'Explicit approved test item',category:'item_magico',kind:'item_magico',basePrice:0,stackable:true,transferable:false};
 await assert.rejects(workflow.createRequestedTemplate(db,'normal@lid',id,spec),{code:'custom_item_admin_required'});
 const created=await workflow.createRequestedTemplate(db,'admin@lid',id,spec);assert.equal(created.template_key,'custom_linked_right_test');assert.equal((await workflow.createRequestedTemplate(db,'admin@lid',id,spec)).duplicate,true);
 await assert.rejects(workflow.createRequestedTemplate(db,'admin@lid',id,{...spec,description:'Changed'}),{code:'custom_item_creation_conflict'});assert.equal((await service.manualRows(db))[0].status,'active');await workflow.approveRequest(db,'admin@lid',id,created.template_key);
});

test('real normal custom purchase debits once and remains active through request/ADM queue',async t=>{
 const db=await fixture(t);for(let n=0;n<14;n++){const id='keep-normal-'+n;await db.run("INSERT INTO jogadores(id,nome,ficha_status) VALUES (?,'Synthetic','aprovada')",[id]);await db.run("INSERT INTO clover_prereset_launch_players(campaign_key,player_id,roster_revision,outcome,status) VALUES (?,?,1,'keep','pending')",[CAMPAIGN,id]);await db.run("INSERT INTO clover_prereset_launch_keep_roster(campaign_key,player_id,roster_revision,added_by) VALUES (?,?,1,'test')",[CAMPAIGN,id]);}
 await require('../helpers/clover/returnPointShopGateService').openReturnPointShop(db,'test');const points=require('../helpers/clover/returnPointsService');await points.creditReturnPoints(db,'manual-owner',250,{operationKey:'custom-normal-credit',source:'fixture',reason:'Synthetic',createdBy:'test'});
 const shop=require('../helpers/clover/returnPointShopService');const input={itemKey:'item_magico_personalizado',idempotencyKey:'custom-normal-buy'};await shop.purchaseReturnPointShopItem(db,'manual-owner',input);await shop.purchaseReturnPointShopItem(db,'manual-owner',input);
 const rights=await workflow.ownerRights(db,'manual-owner');assert.equal(rights.length,1);await workflow.submitRequest(db,'manual-owner',rights[0].entitlement_id,'Normal purchase specification');assert.equal((await db.get('SELECT status FROM clover_prereset_entitlements')).status,'active');assert.equal(await points.getReturnPointsBalance(db,'manual-owner'),0);assert.equal((await db.get('SELECT COUNT(*) n FROM clover_prereset_purchases')).n,1);
});

test('preservation right stays pending without boxes and consumes only after canonical boxes actually survive reset',async t=>{
 const db=await fixture(t);await service.importManualReturnShopObligation(db,imported({effects:[{itemKey:'salvamento_inventario'}]}));await inventory.ensureInventoryV1(db);
 assert.equal((await fulfill(db,'manual-owner',{campaignKey:CAMPAIGN})).fulfilledCount,0);assert.equal((await service.manualRows(db))[0].status,'active');
 await inventory.addCatalogItem(db,'manual-owner','box_rare_v1',1,{source:'fixture'});await inventory.addCatalogItem(db,'manual-owner','pocao_cura_basica',1,{source:'fixture'});
 await require('../helpers/clover/preResetLaunchService').registerBoxPreservations(db,CAMPAIGN,'manual-owner');assert.equal((await fulfill(db,'manual-owner',{campaignKey:CAMPAIGN})).fulfilledCount,0);await db.run("UPDATE clover_prereset_launch_players SET status='applying',reset_operation_code='BOX-PRESERVE-RIGHT' WHERE player_id='manual-owner'");
 assert.equal((await require('../helpers/clover/playerResetService').resetPlayer(db,{playerId:'manual-owner',actorId:'test',operationCode:'BOX-PRESERVE-RIGHT',reason:'Synthetic launch'})).ok,true);
 const result=await fulfill(db,'manual-owner',{campaignKey:CAMPAIGN});assert.equal(result.fulfilledCount,1);assert.equal(result.fulfilled[0].preservedBoxIds.length,1);assert.deepEqual((await db.all("SELECT template_key FROM clover_inventory_items WHERE player_id='manual-owner'")).map(r=>r.template_key),['box_rare_v1']);assert.equal((await service.manualRows(db))[0].status,'consumed');assert.equal((await fulfill(db,'manual-owner',{campaignKey:CAMPAIGN})).fulfilledCount,0);
});

test('historical approved grimoire manifest remains immutable, counts canonical capacity and replays before/after delivery',async t=>{
 const db=await fixture(t);const input=imported({effects:[{itemKey:'grimorio_spade_2'},{itemKey:'reino_spade'}]});
 const effects=[{itemKey:'grimorio_spade_2',effectKind:'grimoire',effectValue:'spade_2',quantity:1,targetMode:'roll'},{itemKey:'reino_spade',effectKind:'kingdom',effectValue:'spade',quantity:1,targetMode:'roll'}];
 const provenance={externalReference:input.externalReference,source:input.source,sourceRowId:input.sourceRowId,acquiredAt:input.acquiredAt};const manifest={playerId:input.playerId,campaignKey:CAMPAIGN,provenance,catalogVersion:'return-shop-v1',effects};const json=JSON.stringify(manifest),hash=require('node:crypto').createHash('sha256').update(json).digest('hex');
 const inserted=await db.run('INSERT INTO clover_return_shop_manual_imports(player_id,operation_key,external_reference,source,source_row_id,acquired_at,imported_by,request_hash,manifest_json) VALUES (?,?,?,?,?,?,?,?,?)',[input.playerId,input.operationKey,input.externalReference,input.source,input.sourceRowId,input.acquiredAt,input.actorId,hash,json]);const importId=inserted.lastID;
 for(const effect of effects)await db.run('INSERT INTO clover_prereset_entitlements(player_id,entitlement_key,manual_import_id,metadata_json) VALUES (?,?,?,?)',[input.playerId,'old-right:'+effect.itemKey,importId,JSON.stringify({...effect,campaignKey:CAMPAIGN,manualImportId:importId,targetRollNumber:null,catalogVersion:'return-shop-v1'})]);
 assert.equal((await service.importManualReturnShopObligation(db,input)).duplicate,true);assert.equal(await service.countManualSlotCommitments(db,'grimoire','spade_4f',CAMPAIGN),1);
 await service.assignManualReturnShopObligation(db,assigned(importId));await service.fulfillManualReturnShopBuild(db,assigned(importId,{operationKey:'legacy-approved-delivery'}));
 assert.equal((await db.get("SELECT grimoire_key FROM clover_prereset_future_rolls WHERE player_id='manual-owner' AND roll_number=1")).grimoire_key,'spade_4f');assert.equal((await service.importManualReturnShopObligation(db,input)).duplicate,true);
 assert.equal((await db.get('SELECT manifest_json FROM clover_return_shop_manual_imports')).manifest_json,json);assert.equal(JSON.parse((await service.manualRows(db))[0].metadata_json).effectValue,'spade_2');
});
