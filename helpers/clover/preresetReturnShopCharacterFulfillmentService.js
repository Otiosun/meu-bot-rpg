'use strict';

const { ensureInventoryV1, addCatalogItemInTransaction } = require('./inventoryService');
const { ensurePhState, addPhInTransaction } = require('./phService');
const { ensureYullsState, addYullsInTransaction } = require('./yullsService');
const { listReturnShopEntitlements, safeJson } = require('./preresetReturnShopAssignmentService');

const INVENTORY_ITEMS = Object.freeze({
    commonBox: 'box_simple_v1',
    rareBox: 'box_rare_v1',
    spellTicket: 'ticket_feitico',
    prioritySpellCoupon: 'cupom_prioridade',
});

const YULL_VALUES = Object.freeze({
    yulls5k: 5000,
    yulls20k: 20000,
});

const DEFERRED_RIGHTS = new Set([
    'royalBox',
    'customMagicItem',
    'echoPastLife',
    'crystalHeart',
    'ryuga',
    'gintetsu',
    'surtr',
    'capibara',
    'kimBambooHat',
    'pickaxe',
    'gunblade',
    'experimentT642',
    'maltyMelromarc',
    'scarf',
    'bindings',
]);

class PreresetReturnShopCharacterFulfillmentError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PreresetReturnShopCharacterFulfillmentError';
        this.code = code;
        this.details = details;
    }
}

function quantityOf(item) {
    const quantity = Number(item?.quantity || 1);
    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new PreresetReturnShopCharacterFulfillmentError(
            'invalid_quantity', 'Quantidade invalida na entrega da Loja de Retorno.', { item }
        );
    }
    return quantity;
}

function isPendingCharacterEntry(entry) {
    return entry.fulfillmentStatus === 'pending_character_fulfillment'
        && entry.requiresRollAssignment === false;
}

async function prepareSchemas(db, playerId) {
    await ensureInventoryV1(db);
    await ensurePhState(db, playerId);
    await ensureYullsState(db, playerId);
}

async function deliverItem(db, entry, item, options) {
    const key = String(item?.key || '').trim();
    const quantity = quantityOf(item);
    const relatedId = `return-shop-entitlement:${entry.entitlementId}:${key}`;
    const common = {
        source: 'return_shop_character_fulfillment',
        relatedId,
        createdBy: options.actorId || 'system',
        metadata: { purchase_id: entry.purchaseId, entitlement_id: entry.entitlementId, item_key: key },
    };

    if (INVENTORY_ITEMS[key]) {
        const result = await addCatalogItemInTransaction(db, entry.playerId, INVENTORY_ITEMS[key], quantity, {
            ...common,
            idempotencyKey: relatedId,
        });
        return { key, quantity, disposition: 'materialized_inventory', templateKey: INVENTORY_ITEMS[key], itemIds: result.items.map(row => row.id) };
    }
    if (key === 'ph') {
        const result = await addPhInTransaction(
            db, entry.playerId, quantity, common.source, 'Compra da Loja de Retorno', common.createdBy,
            common.metadata, relatedId
        );
        return { key, quantity, disposition: 'materialized_ph', ledgerId: result.ledgerId };
    }
    if (YULL_VALUES[key]) {
        const amount = YULL_VALUES[key] * quantity;
        const result = await addYullsInTransaction(
            db, entry.playerId, amount, common.source, 'Compra da Loja de Retorno', common.createdBy,
            { ...common, idempotencyKey: relatedId }
        );
        return { key, quantity, amount, disposition: 'materialized_yulls', ledgerId: result.ledgerId };
    }
    if (key === 'inventorySave') {
        if (!options.inventoryPreservationApplied) {
            return { key, quantity, disposition: 'active_right', reason: 'awaiting_launch_inventory_preservation' };
        }
        return { key, quantity, disposition: 'inventory_preserved' };
    }
    if (DEFERRED_RIGHTS.has(key)) {
        return { key, quantity, disposition: 'active_right', reason: 'canonical_materializer_not_defined' };
    }
    throw new PreresetReturnShopCharacterFulfillmentError(
        'unknown_character_item', `Item da Loja de Retorno sem regra de entrega: ${key || '(vazio)'}.`,
        { entitlementId: entry.entitlementId, item }
    );
}

async function updatePurchaseMetadata(db, purchaseId, patch) {
    const row = await db.get('SELECT metadata_json FROM clover_prereset_purchases WHERE id = ?', [purchaseId]);
    await db.run(
        'UPDATE clover_prereset_purchases SET metadata_json = ? WHERE id = ?',
        [JSON.stringify({ ...safeJson(row?.metadata_json, {}), ...patch }), purchaseId]
    );
}

async function applyInTransaction(db, entry, options) {
    const results = [];
    for (const item of entry.metadata.items || []) results.push(await deliverItem(db, entry, item, options));
    const activeRights = results.filter(result => result.disposition === 'active_right');
    const now = options.now || new Date().toISOString();
    const delivery = { at: now, by: options.actorId || null, items: results };
    const metadata = {
        ...entry.metadata,
        fulfillment_status: 'fulfilled',
        character_fulfilled_at: now,
        character_fulfilled_by: options.actorId || null,
        character_fulfillment_result: delivery,
        active_rights: activeRights,
    };
    const keepActive = activeRights.length > 0;
    await db.run(
        `UPDATE clover_prereset_entitlements
            SET status = ?, consumed_at = ?, metadata_json = ?
          WHERE id = ? AND status = 'active'`,
        [keepActive ? 'active' : 'consumed', keepActive ? null : now, JSON.stringify(metadata), entry.entitlementId]
    );
    await updatePurchaseMetadata(db, entry.purchaseId, {
        fulfillment_status: 'fulfilled',
        character_fulfilled_at: now,
        character_fulfilled_by: options.actorId || null,
        character_fulfillment_result: delivery,
        pending_character_items: [],
        active_rights: activeRights,
    });
    return { entitlementId: entry.entitlementId, purchaseId: entry.purchaseId, keepActive, items: results };
}

async function applyReturnShopCharacterFulfillment(db, options = {}) {
    const playerId = String(options.playerId || '').trim();
    if (!playerId) throw new PreresetReturnShopCharacterFulfillmentError('missing_player', 'Informe o jogador.');
    await prepareSchemas(db, playerId);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const entries = (await listReturnShopEntitlements(db, playerId)).filter(isPendingCharacterEntry);
        const fulfilled = [];
        for (const entry of entries) fulfilled.push(await applyInTransaction(db, entry, options));
        await db.exec('COMMIT');
        return { ok: true, playerId, fulfilled, applied: fulfilled.length > 0 };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    DEFERRED_RIGHTS,
    INVENTORY_ITEMS,
    PreresetReturnShopCharacterFulfillmentError,
    YULL_VALUES,
    applyReturnShopCharacterFulfillment,
    isPendingCharacterEntry,
};
