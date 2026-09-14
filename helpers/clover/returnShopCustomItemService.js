'use strict';
const {withImmediateTransaction}=require('./sqliteImmediateTransactionService');
const {assertLifecycleAllowed}=require('./lifecyclePolicy');
const {getIntegratedAccessContext,contextHasGlobalAdministration}=require('./integratedAccessContextService');
const {getReturnPointShopItem}=require('./returnPointShopCatalog');
const fail=code=>{throw Object.assign(new Error(code),{code});};
function gate(){assertLifecycleAllowed({surface:'internal',operation:'return_shop.custom_item_right',mutationClass:'PRE_RESET'});}
async function admin(db,actorId){if(!contextHasGlobalAdministration(await getIntegratedAccessContext(db,actorId)))fail('custom_item_admin_required');}
async function right(db,id,owner,campaignKey){
 const row=await db.get(`SELECT e.*,p.catalog_item_key,p.status purchase_status FROM clover_prereset_entitlements e LEFT JOIN clover_prereset_purchases p ON p.id=e.purchase_id WHERE e.id=?`,[id]);
 if(!row || row.player_id!==owner)fail('custom_item_wrong_owner');
 const m=row.manual_import_id?require('./returnPointShopManualService').metadata((await require('./returnPointShopManualService').manualRows(db,owner)).find(r=>r.id===row.id)):JSON.parse(row.metadata_json);
 const item=getReturnPointShopItem(row.catalog_item_key||m.itemKey);
 if(item?.itemKey!=='item_magico_personalizado'||m.effectKind!=='future_item_request'||Number(m.quantity)!==1||(!row.manual_import_id&&row.purchase_status!=='completed')||(m.campaignKey&&m.campaignKey!==campaignKey))fail('custom_item_invalid_right');
 return row;
}
async function queueInTransaction(db,owner,id,campaignKey){
 gate();const row=await right(db,id,owner,campaignKey);
 const existing=await db.get('SELECT * FROM clover_return_shop_custom_requests WHERE entitlement_id=?',[id]);
 if(existing){if(existing.player_id!==owner||existing.campaign_key!==campaignKey)fail('custom_item_campaign_conflict');return existing;}
 if(row.status!=='active')fail('custom_item_right_inactive');
 await db.run('INSERT INTO clover_return_shop_custom_requests(entitlement_id,player_id,campaign_key) VALUES (?,?,?)',[id,owner,campaignKey]);
 return db.get('SELECT * FROM clover_return_shop_custom_requests WHERE entitlement_id=?',[id]);
}
async function submitRequest(db,owner,id,description,campaignKey='mythic_launch_v1'){
 gate();const text=String(description||'').trim();if(!text||text.length>2000)fail('custom_item_description_required');
 return withImmediateTransaction(db,async()=>{const r=await queueInTransaction(db,owner,id,campaignKey);if(r.description){if(r.description!==text)fail('custom_item_request_conflict');return {...r,duplicate:true};}if(r.status!=='pending')fail('custom_item_request_locked');await db.run('UPDATE clover_return_shop_custom_requests SET description=? WHERE entitlement_id=?',[text,id]);return db.get('SELECT * FROM clover_return_shop_custom_requests WHERE entitlement_id=?',[id]);});
}
async function listRequests(db,actorId){gate();await admin(db,actorId);return db.all("SELECT * FROM clover_return_shop_custom_requests WHERE status!='delivered' ORDER BY created_at,entitlement_id");}
function snapshot(row){const {created_at,updated_at,...data}=row;return JSON.stringify(data);}
async function approveRequest(db,actorId,id,templateKey){
 gate();await admin(db,actorId);
 return withImmediateTransaction(db,async()=>{
 const r=await db.get('SELECT * FROM clover_return_shop_custom_requests WHERE entitlement_id=?',[id]);if(!r?.description)fail('custom_item_submission_required');
 const template=await db.get('SELECT * FROM clover_item_templates WHERE template_key=?',[templateKey]);
 if(!template?.active||!template.is_custom)fail('custom_item_approved_template_required');
 const json=snapshot(template);
 if(r.status!=='pending'){if(r.template_key!==templateKey||r.template_snapshot_json!==json)fail('custom_item_approval_conflict');return {...r,duplicate:true};}
 const entitlement=await right(db,id,r.player_id,r.campaign_key);if(entitlement.status!=='active')fail('custom_item_right_inactive');
 await db.run("UPDATE clover_return_shop_custom_requests SET status='approved',template_key=?,template_snapshot_json=?,approved_by=?,approved_at=CURRENT_TIMESTAMP WHERE entitlement_id=? AND status='pending'",[templateKey,json,actorId,id]);
 return db.get('SELECT * FROM clover_return_shop_custom_requests WHERE entitlement_id=?',[id]);
 });
}
async function deliverRequest(db,actorId,id){
 gate();await admin(db,actorId);
 return withImmediateTransaction(db,async()=>{
 const r=await db.get('SELECT * FROM clover_return_shop_custom_requests WHERE entitlement_id=?',[id]);if(!r||r.status==='pending')fail('custom_item_approval_required');if(r.status==='delivered')return {...r,duplicate:true};
 const launch=await db.get('SELECT status FROM clover_prereset_launch_players WHERE campaign_key=? AND player_id=?',[r.campaign_key,r.player_id]);if(launch?.status!=='completed')fail('custom_item_launch_pending');
 const entitlement=await right(db,id,r.player_id,r.campaign_key);if(entitlement.status!=='active')fail('custom_item_right_inactive');
 const inventory=require('./inventoryService');await inventory.ensureInventoryV1(db);
 const template=await db.get('SELECT * FROM clover_item_templates WHERE template_key=?',[r.template_key]);if(!template?.active||snapshot(template)!==r.template_snapshot_json)fail('custom_item_template_changed');
 const granted=await inventory.addCatalogItemInTransaction(db,r.player_id,r.template_key,1,{source:'return_shop_custom_item',relatedId:String(id),idempotencyKey:'return-shop:custom:'+id,createdBy:actorId,forceSeparate:true,metadata:{entitlement_id:id,approved_by:r.approved_by,campaign_key:r.campaign_key}});
 const item=granted.items?.[0]||granted.item||granted;const itemId=item.id||granted.itemId;if(!itemId)fail('custom_item_inventory_missing');
 const consumed=await db.run("UPDATE clover_prereset_entitlements SET status='consumed',consumed_at=CURRENT_TIMESTAMP WHERE id=? AND status='active'",[id]);if(consumed.changes!==1)fail('custom_item_consume_conflict');
 await db.run("UPDATE clover_return_shop_custom_requests SET status='delivered',inventory_item_id=?,delivered_by=?,delivered_at=CURRENT_TIMESTAMP WHERE entitlement_id=? AND status='approved'",[itemId,actorId,id]);
 return db.get('SELECT * FROM clover_return_shop_custom_requests WHERE entitlement_id=?',[id]);
 });
}
async function createRequestedTemplate(db,actorId,id,spec){
 gate();await admin(db,actorId);
 if(!spec||!/^[a-z0-9_]{1,48}$/.test(spec.templateKey||''))fail('custom_item_template_key_required');
 const hash=require('node:crypto').createHash('sha256').update(JSON.stringify(spec)).digest('hex');
 return withImmediateTransaction(db,async()=>{
 const r=await db.get('SELECT * FROM clover_return_shop_custom_requests WHERE entitlement_id=?',[id]);if(!r?.description||r.status!=='pending')fail('custom_item_submission_required');
 const entitlement=await right(db,id,r.player_id,r.campaign_key);if(entitlement.status!=='active')fail('custom_item_right_inactive');
 await require('./inventoryService').ensureInventoryV1(db);
 const existing=await db.get('SELECT * FROM clover_item_templates WHERE template_key=?',['custom_'+spec.templateKey]);
 if(existing){const m=JSON.parse(existing.metadata_json||'{}');if(m.return_shop_entitlement_id!==id||m.return_shop_spec_hash!==hash||existing.created_by!==actorId)fail('custom_item_creation_conflict');return {entitlement_id:id,status:'pending',duplicate:true,template_key:existing.template_key};}
 const created=await require('./itemAdminService').createItemTemplateInTransaction(db,actorId,{...spec,metadata:{...(spec.metadata||{}),return_shop_entitlement_id:id,return_shop_spec_hash:hash}});
 return {entitlement_id:id,status:'pending',template_key:created.template.key};
 });
}
async function ownerRights(db,owner){gate();const rows=await db.all(`SELECT e.id,e.status,e.metadata_json,p.catalog_item_key,r.status request_status FROM clover_prereset_entitlements e LEFT JOIN clover_prereset_purchases p ON p.id=e.purchase_id LEFT JOIN clover_return_shop_custom_requests r ON r.entitlement_id=e.id WHERE e.player_id=? AND e.status!='revoked' ORDER BY e.id`,[owner]);return rows.filter(r=>r.catalog_item_key==='item_magico_personalizado'||JSON.parse(r.metadata_json).itemKey==='item_magico_personalizado').map(r=>({entitlement_id:r.id,status:r.request_status||'pending'}));}
module.exports={createRequestedTemplate,ownerRights,queueInTransaction,submitRequest,listRequests,approveRequest,deliverRequest};
