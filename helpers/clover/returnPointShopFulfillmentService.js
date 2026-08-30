'use strict';

const { getReturnPointShopItem } = require('./returnPointShopCatalog');
const { addYullsInTransaction } = require('./yullsService');

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
    const id = requiredId(playerId, 'playerId');
    const campaignKey = requiredId(options.campaignKey || 'prereset-v1', 'campaignKey');
    const actorId = requiredId(options.actorId || 'system', 'actorId');

    await db.exec('BEGIN IMMEDIATE');
    try {
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

        for (const row of rows) {
            const item = getReturnPointShopItem(row.catalog_item_key);
            if (!item || item.effectKind !== 'future_yulls') continue;
            const amount = yullsAmountForEntitlement(row, item);
            const idempotencyKey = `return-shop:fulfillment:yulls:${Number(row.purchase_id)}`;
            const credit = await addYullsInTransaction(
                db,
                id,
                amount,
                'return_point_shop_fulfillment',
                `Materializacao da Loja de Retorno: ${item.name}.`,
                actorId,
                {
                    idempotencyKey,
                    relatedId:String(row.purchase_id),
                    metadata:{
                        campaign_key:campaignKey,
                        entitlement_id:Number(row.id),
                        purchase_id:Number(row.purchase_id),
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

        await db.exec('COMMIT');
        return { ok:true, playerId:id, campaignKey, fulfilledCount:fulfilled.length, yullsAdded, fulfilled };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

module.exports = {
    ReturnPointShopFulfillmentError,
    fulfillReturnPointShopEconomicEntitlements,
    parseMetadata,
    yullsAmountForEntitlement,
};
