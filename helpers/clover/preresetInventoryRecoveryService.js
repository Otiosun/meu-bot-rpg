'use strict';

const crypto = require('node:crypto');
const { ensureInventoryV1, addCatalogItemInTransaction } = require('./inventoryService');
const { ensurePhState, addPhInTransaction } = require('./phService');
const { ensureYullsState, addYullsInTransaction } = require('./yullsService');

const CAMPAIGN_KEY = 'mythic_launch_v1';
const ACTOR_ID = 'owner:prereset-inventory-recovery-20260917';
const SOURCE = 'prereset_inventory_recovery_20260917';

const INVENTORY_ITEMS = Object.freeze({
    commonBox: 'box_simple_v1',
    rareBox: 'box_rare_v1',
    royalBox: 'box_royal_v1',
    spellTicket: 'ticket_feitico',
    prioritySpellCoupon: 'cupom_prioridade',
    bindings: 'return_shop_amarras_coracao',
    scarf: 'return_shop_cachecol_estrelas',
    capibara: 'return_shop_capibara',
    crystalHeart: 'return_shop_coracao_cristal',
});

const YULL_VALUES = Object.freeze({ yulls5k: 5000, yulls20k: 20000 });
const BUILD_ITEMS = new Set([
    'clover', 'heart', 'spade', 'diamond',
    'miserable', 'artisans', 'burguesia', 'nobreza', 'realeza',
    'human', 'witch', 'dwarf', 'elf',
    'threeLeaves', 'fourLeaves', 'heartGrimoire', 'doubleHeart',
    'diamondGrimoire', 'polishedDiamond', 'oneSword', 'twoSwords',
    'rareTrait', 'rareMark', 'anomaly',
]);

const RECOVERY_TEMPLATES = Object.freeze([
    ['box_royal_v1', 'Caixa Real', 'caixa', 'caixa_retorno_pending', true],
    ['ticket_feitico', 'Ticket de Feitiço', 'consumivel', 'ticket_feitico', true],
    ['cupom_prioridade', 'Cupom de Prioridade', 'consumivel', 'cupom_pa', true],
    ['return_shop_amarras_coracao', 'Amarras de um Coração Pulsante', 'item_especial', 'direito_retorno', true],
    ['return_shop_cachecol_estrelas', 'Cachecol das Estrelas', 'item_especial', 'direito_retorno', true],
    ['return_shop_capibara', 'Capibara', 'item_especial', 'direito_retorno', false],
    ['return_shop_coracao_cristal', 'Coração de Cristal', 'item_especial', 'direito_retorno', false],
]);

function parseJson(value) {
    try {
        const parsed = JSON.parse(value || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function quantityOf(item) {
    const quantity = Number(item?.quantity || 1);
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error(`Quantidade inválida: ${item?.key || '?'}`);
    return quantity;
}

function operationKey(...parts) {
    return ['prereset-recovery-20260917', ...parts].map(String).join(':');
}

function stableHash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function tableExists(db, name) {
    return Boolean(await db.get("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?", [name]));
}

async function existingOperationKeys(db) {
    if (!await tableExists(db, 'clover_prereset_inventory_repair_units')) return new Set();
    const rows = await db.all('SELECT operation_key FROM clover_prereset_inventory_repair_units');
    return new Set(rows.map((row) => row.operation_key));
}

async function ensureRepairSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_prereset_inventory_repair_units (
            operation_key TEXT PRIMARY KEY,
            repair_kind TEXT NOT NULL,
            player_id TEXT NOT NULL,
            entitlement_id INTEGER DEFAULT NULL,
            item_key TEXT DEFAULT NULL,
            quantity INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_prereset_inventory_repair_player
        ON clover_prereset_inventory_repair_units(player_id, repair_kind);
    `);
}

async function ensureSpecialTemplates(db) {
    for (const [templateKey, itemName, category, kind, duplicable] of RECOVERY_TEMPLATES) {
        await db.run(
            `INSERT OR IGNORE INTO clover_item_templates
             (template_key,catalog_version,item_name,description,category,kind,origin,base_price,
              default_quality,default_durability,stackable,transferable,properties_json,effects_json,
              metadata_json,active,is_custom,requestable,marketable,duplicable,created_by,created_at,updated_at)
             VALUES (?,1,?,'Item adquirido na Loja de Retorno.',?,?,
                     'Loja de Retorno',0,'comum',NULL,1,0,'{}','{}',?,1,0,0,0,?, ?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
            [templateKey, itemName, category, kind, JSON.stringify({ return_shop: true, campaign_key: CAMPAIGN_KEY }), duplicable ? 1 : 0, ACTOR_ID]
        );
    }
}

async function planBoxRecovery(db, receipts) {
    const rows = await db.all(
        `WITH historical AS (
            SELECT h.player_id,
                   COALESCE(json_extract(h.after_json,'$.template_key'),json_extract(h.before_json,'$.template_key')) template_key,
                   SUM(h.quantity_delta) expected_quantity
              FROM clover_inventory_item_history h
             WHERE COALESCE(json_extract(h.after_json,'$.template_key'),json_extract(h.before_json,'$.template_key'))
                   IN ('box_simple_v1','box_rare_v1','box_royal_v1')
               AND COALESCE(h.source,'') <> ?
             GROUP BY h.player_id,template_key
        ), current_inventory AS (
            SELECT player_id,template_key,SUM(quantity) current_quantity
              FROM clover_inventory_items
             WHERE template_key IN ('box_simple_v1','box_rare_v1','box_royal_v1')
               AND status='disponivel'
             GROUP BY player_id,template_key
        )
        SELECT h.player_id,h.template_key,h.expected_quantity,
               COALESCE(c.current_quantity,0) current_quantity,
               h.expected_quantity-COALESCE(c.current_quantity,0) missing_quantity
          FROM historical h
          JOIN clover_prereset_launch_players lp
            ON lp.player_id=h.player_id AND lp.campaign_key=? AND lp.outcome='reset'
          LEFT JOIN current_inventory c ON c.player_id=h.player_id AND c.template_key=h.template_key
         WHERE h.expected_quantity>COALESCE(c.current_quantity,0)
         ORDER BY h.player_id,h.template_key`,
        [SOURCE, CAMPAIGN_KEY]
    );
    return rows.map((row) => ({
        kind: 'box_carry_recovery',
        operationKey: operationKey('box', row.player_id, row.template_key),
        playerId: row.player_id,
        templateKey: row.template_key,
        quantity: Number(row.missing_quantity),
        expectedQuantity: Number(row.expected_quantity),
        currentQuantity: Number(row.current_quantity),
    })).filter((entry) => !receipts.has(entry.operationKey));
}

function classifyShopItem(item) {
    const key = String(item?.key || '').trim();
    if (INVENTORY_ITEMS[key]) return { type: 'inventory', key, templateKey: INVENTORY_ITEMS[key] };
    if (key === 'ph') return { type: 'ph', key };
    if (YULL_VALUES[key]) return { type: 'yulls', key, unitAmount: YULL_VALUES[key] };
    if (key === 'customMagicItem') return { type: 'custom_request', key };
    if (key === 'inventorySave') return { type: 'inventory_preservation', key };
    if (BUILD_ITEMS.has(key)) return { type: 'build_pending', key };
    return { type: 'unknown', key };
}

async function planShopRecovery(db, receipts) {
    const rows = await db.all(
        `SELECT e.id entitlement_id,e.player_id,e.metadata_json,p.id purchase_id,p.catalog_item_key,p.status purchase_status,
                p.return_points_ledger_id
           FROM clover_prereset_entitlements e
           JOIN clover_prereset_purchases p ON p.id=e.purchase_id
          WHERE e.status='active' AND p.status='completed'
            AND p.catalog_item_key IN ('return_shop_global_package','return_shop_normal_package')
          ORDER BY e.id`
    );
    const entitlements = [];
    const unknown = [];
    for (const row of rows) {
        const metadata = parseJson(row.metadata_json);
        const items = Array.isArray(metadata.items) ? metadata.items : [];
        const actions = [];
        for (const item of items) {
            const classified = classifyShopItem(item);
            const quantity = quantityOf(item);
            const key = operationKey('shop', row.entitlement_id, classified.key);
            const action = { ...classified, operationKey:key, quantity, item };
            if (classified.type === 'unknown') unknown.push({ entitlementId:row.entitlement_id, item });
            if (!receipts.has(key) && !['build_pending', 'unknown'].includes(classified.type)) actions.push(action);
        }
        entitlements.push({
            entitlementId:Number(row.entitlement_id), purchaseId:Number(row.purchase_id), playerId:row.player_id,
            returnPointsLedgerId:Number(row.return_points_ledger_id || 0),
            metadata, items, actions,
            pendingBuild:items.filter((item) => classifyShopItem(item).type === 'build_pending'),
            pendingCustom:items.filter((item) => classifyShopItem(item).type === 'custom_request'),
        });
    }
    return { entitlements, unknown };
}

async function planPreresetInventoryRecovery(db) {
    const receipts = await existingOperationKeys(db);
    const boxes = await planBoxRecovery(db, receipts);
    const shop = await planShopRecovery(db, receipts);
    const summary = {
        boxPlayers:new Set(boxes.map((entry) => entry.playerId)).size,
        boxes:boxes.reduce((acc, entry) => ({ ...acc, [entry.templateKey]:(acc[entry.templateKey] || 0) + entry.quantity }), {}),
        shopActions:shop.entitlements.reduce((sum, entry) => sum + entry.actions.length, 0),
        unknown:shop.unknown.length,
    };
    const hashInput = {
        boxes:boxes.map(({ operationKey:key, playerId, templateKey, quantity }) => ({ key, playerId, templateKey, quantity })),
        shop:shop.entitlements.map((entry) => ({
            entitlementId:entry.entitlementId,
            actions:entry.actions.map(({ operationKey:key, type, key:itemKey, quantity, templateKey, unitAmount }) => ({ key, type, itemKey, quantity, templateKey, unitAmount })),
        })),
    };
    return { ok:shop.unknown.length === 0, planHash:stableHash(hashInput), summary, boxes, ...shop };
}

async function recordUnit(db, entry) {
    await db.run(
        `INSERT INTO clover_prereset_inventory_repair_units
         (operation_key,repair_kind,player_id,entitlement_id,item_key,quantity,payload_json,created_by)
         VALUES (?,?,?,?,?,?,?,?)`,
        [entry.operationKey,entry.kind,entry.playerId,entry.entitlementId || null,entry.itemKey || null,
            entry.quantity,JSON.stringify(entry.payload || {}),ACTOR_ID]
    );
}

async function grantInventory(db, playerId, templateKey, quantity, key, metadata = {}) {
    return addCatalogItemInTransaction(db, playerId, templateKey, quantity, {
        source:SOURCE, relatedId:key, idempotencyKey:key, createdBy:ACTOR_ID, forceSeparate:true,
        metadata:{ campaign_key:CAMPAIGN_KEY, ...metadata },
    });
}

async function applyShopAction(db, entitlement, action) {
    const base = {
        operationKey:action.operationKey, kind:`shop_${action.type}`, playerId:entitlement.playerId,
        entitlementId:entitlement.entitlementId, itemKey:action.key, quantity:action.quantity,
        payload:{ purchase_id:entitlement.purchaseId },
    };
    if (action.type === 'inventory') {
        const granted = await grantInventory(db, entitlement.playerId, action.templateKey, action.quantity, action.operationKey, {
            entitlement_id:entitlement.entitlementId, purchase_id:entitlement.purchaseId, item_key:action.key,
        });
        base.payload.template_key = action.templateKey;
        base.payload.inventory_item_ids = granted.items.map((item) => item.id);
    } else if (action.type === 'ph') {
        const result = await addPhInTransaction(db, entitlement.playerId, action.quantity, SOURCE,
            'Compra da Loja de Retorno', ACTOR_ID,
            { campaign_key:CAMPAIGN_KEY, entitlement_id:entitlement.entitlementId, purchase_id:entitlement.purchaseId }, action.operationKey);
        base.payload.ledger_id = result.ledgerId;
    } else if (action.type === 'yulls') {
        const amount = action.unitAmount * action.quantity;
        const result = await addYullsInTransaction(db, entitlement.playerId, amount, SOURCE,
            'Compra da Loja de Retorno', ACTOR_ID, {
                relatedId:action.operationKey, idempotencyKey:action.operationKey,
                metadata:{ campaign_key:CAMPAIGN_KEY, entitlement_id:entitlement.entitlementId, purchase_id:entitlement.purchaseId },
            });
        base.payload.amount = amount;
        base.payload.ledger_id = result.ledgerId;
    } else if (action.type === 'custom_request') {
        if (action.quantity !== 1) throw new Error('Item mágico personalizado legado exige quantidade unitária.');
        await db.run(
            `INSERT OR IGNORE INTO clover_return_shop_custom_requests(entitlement_id,player_id,campaign_key)
             VALUES (?,?,?)`,
            [entitlement.entitlementId, entitlement.playerId, CAMPAIGN_KEY]
        );
        base.payload.status = 'pending';
        base.payload.migrated_entitlement_id = entitlement.entitlementId;
    } else if (action.type === 'inventory_preservation') {
        base.payload.boxes_recovered_by_global_policy = true;
    } else {
        throw new Error(`Ação de loja não suportada: ${action.type}`);
    }
    await recordUnit(db, base);
}

async function updateLegacyEntitlement(db, entitlement) {
    const custom = entitlement.items.filter((item) => classifyShopItem(item).type === 'custom_request');
    const remaining = entitlement.items.filter((item) => {
        const type = classifyShopItem(item).type;
        return type === 'build_pending';
    });
    if (custom.length) {
        if (custom.length !== 1 || remaining.length) {
            throw new Error(`Pacote legado ${entitlement.entitlementId} mistura direito personalizado com build pendente.`);
        }
        const now = new Date().toISOString();
        const metadata = {
            ...entitlement.metadata,
            items:custom,
            itemKey:'item_magico_personalizado',
            effectKind:'future_item_request',
            quantity:1,
            campaignKey:CAMPAIGN_KEY,
            fulfillment_status:'pending_custom_request',
            requires_roll_assignment:false,
            character_fulfilled_at:now,
            character_fulfilled_by:ACTOR_ID,
            recovery_operation:'prereset_inventory_recovery_20260917',
        };
        await db.run(
            `UPDATE clover_prereset_entitlements
                SET status='active',consumed_at=NULL,metadata_json=?
              WHERE id=? AND status='active'`,
            [JSON.stringify(metadata), entitlement.entitlementId]
        );
        const purchase = await db.get('SELECT metadata_json FROM clover_prereset_purchases WHERE id=?', [entitlement.purchaseId]);
        await db.run(
            `UPDATE clover_prereset_purchases
                SET catalog_item_key='item_magico_personalizado',metadata_json=?
              WHERE id=?`,
            [JSON.stringify({
                ...parseJson(purchase?.metadata_json),
                fulfillment_status:'pending_custom_request',
                pending_character_items:custom,
                character_fulfilled_at:now,
                character_fulfilled_by:ACTOR_ID,
                recovery_operation:'prereset_inventory_recovery_20260917',
            }),entitlement.purchaseId]
        );
        return;
    }
    const hasBuild = remaining.some((item) => classifyShopItem(item).type === 'build_pending');
    const now = new Date().toISOString();
    const metadata = {
        ...entitlement.metadata,
        items:remaining,
        fulfillment_status:hasBuild ? 'pending_roll_assignment' : 'fulfilled',
        requires_roll_assignment:hasBuild,
        character_fulfilled_at:now,
        character_fulfilled_by:ACTOR_ID,
        recovery_operation:'prereset_inventory_recovery_20260917',
    };
    await db.run(
        `UPDATE clover_prereset_entitlements
            SET status=?,consumed_at=?,metadata_json=?
          WHERE id=? AND status='active'`,
        [remaining.length ? 'active' : 'consumed', remaining.length ? null : now, JSON.stringify(metadata), entitlement.entitlementId]
    );
    const purchase = await db.get('SELECT metadata_json FROM clover_prereset_purchases WHERE id=?', [entitlement.purchaseId]);
    const purchaseMetadata = {
        ...parseJson(purchase?.metadata_json),
        fulfillment_status:remaining.length ? 'partial_character_fulfilled' : 'fulfilled',
        pending_character_items:remaining,
        character_fulfilled_at:now,
        character_fulfilled_by:ACTOR_ID,
        recovery_operation:'prereset_inventory_recovery_20260917',
    };
    await db.run('UPDATE clover_prereset_purchases SET metadata_json=? WHERE id=?', [JSON.stringify(purchaseMetadata), entitlement.purchaseId]);
}

async function applyPreresetInventoryRecovery(db, request = {}) {
    if (!request.execute) throw new Error('Aplicação real exige execute=true.');
    await ensureInventoryV1(db);
    const before = await planPreresetInventoryRecovery(db);
    if (!before.ok) throw new Error(`Plano contém ${before.unknown.length} item(ns) desconhecido(s).`);
    if (request.expectedPlanHash && request.expectedPlanHash !== before.planHash) throw new Error('Plano mudou desde o preflight.');

    const resourcePlayers = new Set();
    for (const entitlement of before.entitlements) {
        if (entitlement.actions.some((action) => action.type === 'ph' || action.type === 'yulls')) resourcePlayers.add(entitlement.playerId);
    }
    for (const playerId of resourcePlayers) {
        await ensurePhState(db, playerId);
        await ensureYullsState(db, playerId);
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        await ensureRepairSchema(db);
        await ensureSpecialTemplates(db);
        const locked = await planPreresetInventoryRecovery(db);
        if (!locked.ok || locked.planHash !== before.planHash) throw new Error('Plano mudou durante a aplicação.');
        for (const box of locked.boxes) {
            const granted = await grantInventory(db, box.playerId, box.templateKey, box.quantity, box.operationKey, {
                repair_kind:'box_carry_recovery', expected_quantity:box.expectedQuantity, previous_quantity:box.currentQuantity,
            });
            await recordUnit(db, {
                ...box, entitlementId:null, itemKey:box.templateKey,
                payload:{ inventory_item_ids:granted.items.map((item) => item.id), expected_quantity:box.expectedQuantity, previous_quantity:box.currentQuantity },
            });
        }
        for (const entitlement of locked.entitlements) {
            for (const action of entitlement.actions) await applyShopAction(db, entitlement, action);
            if (entitlement.actions.length) await updateLegacyEntitlement(db, entitlement);
        }
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
    return { ok:true, applied:true, before, after:await planPreresetInventoryRecovery(db) };
}

module.exports = {
    ACTOR_ID,
    CAMPAIGN_KEY,
    SOURCE,
    applyPreresetInventoryRecovery,
    planPreresetInventoryRecovery,
};
