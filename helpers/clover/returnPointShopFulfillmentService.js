'use strict';

const { getReturnPointShopItem } = require('./returnPointShopCatalog');
const {inventoryProvider,hasEconomicProvider}=require('./returnPointShopEconomicProviders');
const {assertLifecycleAllowed}=require('./lifecyclePolicy');
const { addYullsInTransaction } = require('./yullsService');
const { withImmediateTransaction } = require('./sqliteImmediateTransactionService');

class ReturnPointShopFulfillmentError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ReturnPointShopFulfillmentError';
        this.code = code;
        this.details = details;
    }
}

function requiredId(value, label) {
    const text = String(value || '').trim();
    if (!text || text.length > 255) {
        throw new ReturnPointShopFulfillmentError('invalid_fulfillment_argument', `${label} invalido.`);
    }
    return text;
}

function parseMetadata(value, details = {}) {
    try {
        const parsed = JSON.parse(String(value || '{}'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not_object');
        return parsed;
    } catch {
        throw new ReturnPointShopFulfillmentError(
            'return_shop_entitlement_metadata_invalid',
            'Entitlement da Loja de Retorno possui metadata invalida.',
            details
        );
    }
}

function yullsAmountForEntitlement(row, item) {
    const metadata = parseMetadata(row.metadata_json, {
        entitlementId:Number(row.id),
        purchaseId:Number(row.purchase_id),
        catalogItemKey:row.catalog_item_key,
    });
    if (String(metadata.effectKind || '') !== 'future_yulls') {
        throw new ReturnPointShopFulfillmentError(
            'return_shop_entitlement_effect_mismatch',
            'Entitlement de Yulls diverge do efeito comprado.',
            { entitlementId:Number(row.id), catalogItemKey:row.catalog_item_key }
        );
    }
    const snapshotValue = Number(metadata.effectValue);
    const catalogValue = Number(item.effectValue);
    const quantity = Number(metadata.quantity ?? 1);
    if (!Number.isSafeInteger(snapshotValue) || snapshotValue <= 0
        || !Number.isSafeInteger(catalogValue) || catalogValue <= 0
        || snapshotValue !== catalogValue
        || !Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new ReturnPointShopFulfillmentError(
            'return_shop_yulls_snapshot_invalid',
            'Snapshot do entitlement de Yulls nao confere com o catalogo canonico.',
            { entitlementId:Number(row.id), catalogItemKey:row.catalog_item_key }
        );
    }
    const amount = snapshotValue * quantity;
    if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new ReturnPointShopFulfillmentError(
            'return_shop_yulls_amount_invalid',
            'Quantidade final de Yulls do entitlement e invalida.',
            { entitlementId:Number(row.id), catalogItemKey:row.catalog_item_key }
        );
    }
    return amount;
}

async function fulfillReturnPointShopEconomicEntitlements(db, playerId, options = {}) {
    assertLifecycleAllowed({surface:'internal',operation:'return_shop.fulfill_existing_rights',mutationClass:'PRE_RESET'});
    const id = requiredId(playerId, 'playerId');
    const campaignKey = requiredId(options.campaignKey || 'prereset-v1', 'campaignKey');
    const actorId = requiredId(options.actorId || 'system', 'actorId');

    return withImmediateTransaction(db, async () => {
        const rows = await db.all(
            `SELECT e.id,e.player_id,e.entitlement_key,e.purchase_id,e.status,e.metadata_json,
                    p.catalog_item_key,p.status AS purchase_status
             FROM clover_prereset_entitlements e
             JOIN clover_prereset_purchases p ON p.id=e.purchase_id
             WHERE e.player_id=? AND e.status='active' AND p.status='completed'
             ORDER BY e.id`,
            [id]
        );
        const fulfilled = [];
        let yullsAdded = 0;

        const manualService = require('./returnPointShopManualService');
        const manual = (await manualService.manualRows(db,id)).filter(row => row.status === 'active'
            && manualService.metadata(row).campaignKey === campaignKey);
        for (const row of manual) {
            const m = manualService.metadata(row);
            if (m.targetMode === 'roll') continue;
            if (!hasEconomicProvider(m.itemKey)) {
                throw new ReturnPointShopFulfillmentError('manual_delivery_provider_pending',
                    'Obrigacao historica requer provedor moderno antes do launch.', { entitlementId:row.id, effectKind:m.effectKind });
            }
            rows.push({...row,catalog_item_key:m.itemKey});
        }

        for (const row of rows) {
            const item = getReturnPointShopItem(row.catalog_item_key);
            if (!item) continue;
            if(item.itemKey==='salvamento_inventario'){
                const snapshot=parseMetadata(row.metadata_json,{entitlementId:row.id});
                if(snapshot.effectKind!=='inventory_preservation'||Number(snapshot.quantity)!==1||snapshot.effectValue!==null) throw new ReturnPointShopFulfillmentError('return_shop_preservation_snapshot_invalid','Direito de preservacao diverge do catalogo.',{entitlementId:row.id});
                const applied=await db.get(`SELECT lp.status,ev.status reset_status FROM clover_prereset_launch_players lp LEFT JOIN clover_player_reset_events ev ON ev.operation_code=lp.reset_operation_code AND ev.player_id=lp.player_id WHERE lp.campaign_key=? AND lp.player_id=? AND lp.outcome='reset'`,[campaignKey,id]);
                if(!applied || (applied.status!=='completed' && !(applied.status==='applying' && applied.reset_status==='applied'))) continue;
                const keys=require('./preResetLaunchService').boxTemplateKeys();
                const preserved=await db.all(`SELECT p.inventory_item_id,p.template_key FROM clover_prereset_launch_inventory_preservations p JOIN clover_inventory_items i ON i.id=p.inventory_item_id AND i.player_id=p.player_id AND i.template_key=p.template_key WHERE p.campaign_key=? AND p.player_id=? AND p.status='active' AND p.template_key IN (${keys.map(()=>'?').join(',')}) ORDER BY p.inventory_item_id`,[campaignKey,id,...keys]);
                // No delivered boxes means no consumed right: preserve it pending.
                if(!preserved.length) continue;
                const consumed=await db.run("UPDATE clover_prereset_entitlements SET status='consumed',consumed_at=COALESCE(consumed_at,CURRENT_TIMESTAMP) WHERE id=? AND player_id=? AND status='active'",[row.id,id]);
                if(Number(consumed?.changes)!==1) throw new ReturnPointShopFulfillmentError('return_shop_entitlement_consume_conflict','Entitlement mudou durante a preservacao.',{entitlementId:row.id});
                fulfilled.push({entitlementId:Number(row.id),catalogItemKey:item.itemKey,effectKind:item.effectKind,preservedBoxIds:preserved.map(p=>p.inventory_item_id)});
                continue;
            }
            if(item.itemKey==='item_magico_personalizado'){await require('./returnShopCustomItemService').queueInTransaction(db,id,row.id,campaignKey);continue;}
            const templateKey=inventoryProvider(item);
            if(templateKey){
                const snapshot=parseMetadata(row.metadata_json,{entitlementId:row.id});
                const quantity=Number(snapshot.quantity);
                if(snapshot.effectKind!==item.effectKind || snapshot.effectValue!==templateKey
                    || !Number.isSafeInteger(quantity) || quantity<1 || quantity>item.maxQuantityPerPurchase){
                    throw new ReturnPointShopFulfillmentError('return_shop_inventory_snapshot_invalid','Snapshot de item futuro diverge do catalogo.',{entitlementId:row.id});
                }
                const {ensureInventoryV1,addCatalogItemInTransaction}=require('./inventoryService');
                await ensureInventoryV1(db);
                const relatedId='return-shop:entitlement:'+Number(row.id);
                await addCatalogItemInTransaction(db,id,templateKey,quantity,{
                    source:'return_point_shop_fulfillment',relatedId,idempotencyKey:relatedId,createdBy:actorId,forceSeparate:true,
                    metadata:{campaign_key:campaignKey,entitlement_id:Number(row.id),purchase_id:row.purchase_id,manual_import_id:row.manual_import_id || null,catalog_item_key:item.itemKey},
                });
                const consumed=await db.run("UPDATE clover_prereset_entitlements SET status='consumed',consumed_at=COALESCE(consumed_at,CURRENT_TIMESTAMP) WHERE id=? AND player_id=? AND status='active'",[row.id,id]);
                if(Number(consumed?.changes)!==1) throw new ReturnPointShopFulfillmentError('return_shop_entitlement_consume_conflict','Entitlement mudou durante a entrega.',{entitlementId:row.id});
                fulfilled.push({entitlementId:Number(row.id),purchaseId:Number(row.purchase_id),catalogItemKey:item.itemKey,effectKind:item.effectKind,amount:quantity,templateKey,idempotencyKey:relatedId});
                continue;
            }
            if(item.itemKey==='ph_1'){
                const credit=await require('./returnShopFuturePhService').creditFuturePhInTransaction(db,id,row,item,{campaignKey,actorId});
                if(!credit) continue;
                const consumed=await db.run("UPDATE clover_prereset_entitlements SET status='consumed',consumed_at=COALESCE(consumed_at,CURRENT_TIMESTAMP) WHERE id=? AND player_id=? AND status='active'",[row.id,id]);
                if(Number(consumed?.changes)!==1) throw new ReturnPointShopFulfillmentError('return_shop_entitlement_consume_conflict','Entitlement mudou durante a entrega de PH.',{entitlementId:row.id});
                fulfilled.push({entitlementId:Number(row.id),catalogItemKey:item.itemKey,effectKind:item.effectKind,amount:credit.amount,ledgerId:credit.ledgerId});
                continue;
            }
            if(item.effectKind!=='future_yulls') continue;
            const amount = yullsAmountForEntitlement(row, item);
            const idempotencyKey = row.manual_import_id
                ? `return-shop:fulfillment:manual-yulls:${Number(row.id)}`
                : `return-shop:fulfillment:yulls:${Number(row.purchase_id)}`;
            const credit = await addYullsInTransaction(
                db,
                id,
                amount,
                'return_point_shop_fulfillment',
                `Materializacao da Loja de Retorno: ${item.name}.`,
                actorId,
                {
                    idempotencyKey,
                    relatedId:String(row.manual_import_id ? `manual:${row.manual_import_id}` : row.purchase_id),
                    metadata:{
                        campaign_key:campaignKey,
                        entitlement_id:Number(row.id),
                        purchase_id:Number(row.purchase_id),
                        ...(row.manual_import_id ? {manual_import_id:Number(row.manual_import_id)} : {}),
                        catalog_item_key:item.itemKey,
                    },
                }
            );
            const consumed = await db.run(
                `UPDATE clover_prereset_entitlements
                 SET status='consumed',consumed_at=COALESCE(consumed_at,CURRENT_TIMESTAMP)
                 WHERE id=? AND player_id=? AND status='active'`,
                [row.id,id]
            );
            if (Number(consumed?.changes || 0) !== 1) {
                throw new ReturnPointShopFulfillmentError(
                    'return_shop_entitlement_consume_conflict',
                    'Entitlement mudou enquanto era materializado.',
                    { entitlementId:Number(row.id), purchaseId:Number(row.purchase_id) }
                );
            }
            yullsAdded += amount;
            fulfilled.push({
                entitlementId:Number(row.id),
                purchaseId:Number(row.purchase_id),
                catalogItemKey:item.itemKey,
                effectKind:item.effectKind,
                amount,
                duplicate:Boolean(credit?.duplicate),
                idempotencyKey,
            });
        }

        return { ok:true, playerId:id, campaignKey, fulfilledCount:fulfilled.length, yullsAdded, fulfilled };
    });
}

module.exports = {
    ReturnPointShopFulfillmentError,
    fulfillReturnPointShopEconomicEntitlements,
    parseMetadata,
    yullsAmountForEntitlement,
};
