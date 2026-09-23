'use strict';

const crypto = require('node:crypto');
const { addCatalogItemInTransaction, ensureInventoryV1 } = require('./inventoryService');
const { ensurePreresetManualPurchaseSchema } = require('./prManualPurchaseImportService');
const { spendYullsInTransaction } = require('./yullsService');

const CAMPAIGN_KEY = 'mythic_launch_v1';
const SOURCE = 'prereset_keep_economy_repair_20260918';
const ACTOR_ID = 'owner:prereset-keep-economy-repair-20260918';
const APOSTOLO_ID = '90826378051713@lid';
const RELIC_TEMPLATE_KEY = 'reliquia_capa_itens_inuteis';
const RELIC_PURCHASE_KEY = 'return-shop-keep-correction-20260918:apostolo:relic-ticket';
const RELIC_REPAIR_KEY = `${SOURCE}:apostolo:relic-ticket`;

function stableHash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseJson(value) {
    try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function isBox(item) {
    return item.category === 'caixa'
        || ['box_simple_v1', 'box_rare_v1', 'box_royal_v1'].includes(item.template_key)
        || /^caixa\b/i.test(String(item.item_name || '').trim());
}

async function tableExists(db, tableName) {
    return Boolean(await db.get("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?", [tableName]));
}

async function ensureRepairSchema(db) {
    await ensurePreresetManualPurchaseSchema(db);
    await ensureInventoryV1(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_prereset_keep_economy_repairs (
            operation_key TEXT PRIMARY KEY,
            campaign_key TEXT NOT NULL,
            player_id TEXT NOT NULL,
            repair_kind TEXT NOT NULL,
            before_json TEXT NOT NULL,
            after_json TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_prereset_keep_economy_repairs_player
        ON clover_prereset_keep_economy_repairs(player_id, repair_kind);
    `);
}

async function repairReceipts(db) {
    if (!await tableExists(db, 'clover_prereset_keep_economy_repairs')) return new Set();
    const rows = await db.all('SELECT operation_key FROM clover_prereset_keep_economy_repairs');
    return new Set(rows.map((row) => row.operation_key));
}

async function returnPointBalance(db, playerId) {
    const row = await db.get(
        'SELECT COALESCE(SUM(amount),0) balance FROM clover_return_points_ledger WHERE player_id=?',
        [playerId]
    );
    return Number(row?.balance || 0);
}

async function keepPlayers(db) {
    return db.all(
        `SELECT lp.player_id,lp.completed_at,j.nome,j.personagem_nome,COALESCE(j.dinheiro,0) dinheiro
           FROM clover_prereset_launch_players lp
           JOIN jogadores j ON j.id=lp.player_id
          WHERE lp.campaign_key=? AND lp.outcome='keep' AND lp.status='completed'
          ORDER BY lp.player_id`,
        [CAMPAIGN_KEY]
    );
}

async function planPreresetKeepEconomyRepair(db) {
    const receipts = await repairReceipts(db);
    const players = [];
    const blockers = [];
    for (const player of await keepPlayers(db)) {
        const operationKey = `${SOURCE}:player:${player.player_id}`;
        if (!receipts.has(operationKey)) {
            const postLaunchYulls = await db.all(
                `SELECT id,amount,source,created_at FROM clover_yulls_ledger
                  WHERE player_id=? AND created_at>?
                    AND COALESCE(source,'') NOT IN (?, 'opening_balance')
                  ORDER BY id`,
                [player.player_id, player.completed_at, SOURCE]
            );
            if (postLaunchYulls.length) {
                blockers.push({ playerId:player.player_id, reason:'post_launch_yulls_activity', entries:postLaunchYulls });
            }
        }
        const inventory = await db.all(
            `SELECT * FROM clover_inventory_items
              WHERE player_id=? AND quantity>0 AND COALESCE(status,'disponivel')<>'consumido'
              ORDER BY id`,
            [player.player_id]
        );
        const removableItems = inventory.filter((item) => !isBox(item) && String(item.created_at || '') <= String(player.completed_at || ''));
        const boxes = inventory.filter(isBox);
        players.push({
            playerId:player.player_id,
            name:player.personagem_nome || player.nome,
            completedAt:player.completed_at,
            moneyBefore:Number(player.dinheiro || 0),
            boxes:boxes.map((item) => ({ id:item.id, templateKey:item.template_key, quantity:Number(item.quantity || 0) })),
            removableItems:removableItems.map((item) => ({
                id:Number(item.id), itemName:item.item_name, templateKey:item.template_key,
                quantity:Number(item.quantity || 0), snapshot:item,
            })),
            operationKey,
            pending:!receipts.has(operationKey) && (Number(player.dinheiro || 0) > 0 || removableItems.length > 0),
        });
    }

    const existingPurchase = await db.get(
        'SELECT * FROM clover_prereset_purchases WHERE idempotency_key=?',
        [RELIC_PURCHASE_KEY]
    );
    const relicOwner = await db.get(
        'SELECT * FROM clover_seasonal_relic_ownership WHERE relic_key=?',
        [RELIC_TEMPLATE_KEY]
    );
    const relicTemplate = await db.get(
        'SELECT template_key,item_name FROM clover_item_templates WHERE template_key=? AND active=1',
        [RELIC_TEMPLATE_KEY]
    );
    const apostoloBalance = await returnPointBalance(db, APOSTOLO_ID);
    if (!relicTemplate) blockers.push({ playerId:APOSTOLO_ID, reason:'relic_template_missing' });
    if (relicOwner && relicOwner.player_id !== APOSTOLO_ID) {
        blockers.push({ playerId:APOSTOLO_ID, reason:'relic_owned_by_other_player', owner:relicOwner.player_id });
    }
    const relicAlreadyApplied = Boolean(existingPurchase || receipts.has(RELIC_REPAIR_KEY));
    if (!relicAlreadyApplied && apostoloBalance < 1000) {
        blockers.push({ playerId:APOSTOLO_ID, reason:'insufficient_return_points', balance:apostoloBalance, required:1000 });
    }

    const relic = {
        pending:!relicAlreadyApplied,
        existingPurchaseId:existingPurchase?.id || null,
        balanceBefore:apostoloBalance,
        templateKey:RELIC_TEMPLATE_KEY,
        itemName:relicTemplate?.item_name || null,
        owner:relicOwner?.player_id || null,
    };
    const hashInput = {
        players:players.filter((player) => player.pending).map((player) => ({
            playerId:player.playerId,
            moneyBefore:player.moneyBefore,
            itemIds:player.removableItems.map((item) => item.id),
            boxes:player.boxes,
        })),
        relic,
        blockers,
    };
    return {
        ok:blockers.length === 0,
        planHash:stableHash(hashInput),
        campaignKey:CAMPAIGN_KEY,
        summary:{
            keepPlayers:players.length,
            pendingPlayers:players.filter((player) => player.pending).length,
            moneyToReset:players.filter((player) => player.pending).reduce((sum, player) => sum + player.moneyBefore, 0),
            itemRecordsToArchive:players.filter((player) => player.pending).reduce((sum, player) => sum + player.removableItems.length, 0),
            itemUnitsToArchive:players.filter((player) => player.pending).reduce((sum, player) => sum + player.removableItems.reduce((subtotal, item) => subtotal + item.quantity, 0), 0),
            boxUnitsPreserved:players.reduce((sum, player) => sum + player.boxes.reduce((subtotal, item) => subtotal + item.quantity, 0), 0),
            relicPurchasePending:relic.pending,
        },
        players,
        relic,
        blockers,
    };
}

async function recordRepair(db, operationKey, playerId, repairKind, before, after) {
    await db.run(
        `INSERT INTO clover_prereset_keep_economy_repairs
         (operation_key,campaign_key,player_id,repair_kind,before_json,after_json,created_by)
         VALUES (?,?,?,?,?,?,?)`,
        [operationKey,CAMPAIGN_KEY,playerId,repairKind,JSON.stringify(before),JSON.stringify(after),ACTOR_ID]
    );
}

async function archiveInventoryItem(db, playerId, item) {
    await db.run(
        `UPDATE clover_inventory_reservations
            SET status='released',released_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
          WHERE inventory_item_id=? AND status='active'`,
        [item.id]
    );
    await db.run(
        `INSERT INTO clover_inventory_item_history
         (item_id,player_id,action,quantity_delta,durability_delta,before_json,after_json,
          source,related_id,idempotency_key,created_by,metadata_json)
         VALUES (?,?,? ,?,0,?,NULL,?,?,?,?,?)`,
        [item.id,playerId,'prereset_keep_cleanup',-item.quantity,JSON.stringify(item.snapshot),SOURCE,
            `${SOURCE}:item:${item.id}`,`${SOURCE}:item:${item.id}`,ACTOR_ID,
            JSON.stringify({ campaign_key:CAMPAIGN_KEY, preserved_character:true })]
    );
    await db.run(
        `UPDATE clover_inventory_items
            SET status='consumido',updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND player_id=?`,
        [item.id,playerId]
    );
}

async function applyApostoloRelicPurchase(db) {
    const existing = await db.get('SELECT * FROM clover_prereset_keep_economy_repairs WHERE operation_key=?', [RELIC_REPAIR_KEY]);
    if (existing) return { duplicate:true, repairOperationKey:RELIC_REPAIR_KEY };
    const balance = await returnPointBalance(db, APOSTOLO_ID);
    if (balance < 1000) throw new Error(`Saldo PR do Apostolo insuficiente: ${balance}`);
    const ledger = await db.run(
        `INSERT INTO clover_return_points_ledger
         (player_id,amount,entry_kind,operation_key,source,reason,policy_version,reset_cycle_key,
          related_id,correlation_id,created_by,metadata_json)
         VALUES (?,-1000,'debit',?,?,?,?,?,?,?,?,?)`,
        [APOSTOLO_ID,`${SOURCE}:apostolo:relic-ticket-debit`,SOURCE,
            'Compra confirmada: Ticket Reliquia - Capa dos Itens (in)uteis',
            'return_shop_keep_correction_20260918',CAMPAIGN_KEY,RELIC_PURCHASE_KEY,
            RELIC_PURCHASE_KEY,ACTOR_ID,JSON.stringify({ owner_confirmed:true, result:RELIC_TEMPLATE_KEY })]
    );
    await db.run(
        `INSERT INTO clover_seasonal_relic_ownership
         (relic_key,player_id,inventory_item_id,box_opening_id,metadata_json)
         VALUES (?,?,NULL,?,?)`,
        [RELIC_TEMPLATE_KEY,APOSTOLO_ID,-Number(ledger.lastID),JSON.stringify({
            source:SOURCE, return_points_ledger_id:Number(ledger.lastID), repair_operation_key:RELIC_REPAIR_KEY,
        })]
    );
    const granted = await addCatalogItemInTransaction(db, APOSTOLO_ID, RELIC_TEMPLATE_KEY, 1, {
        source:SOURCE,
        relatedId:RELIC_PURCHASE_KEY,
        idempotencyKey:`${RELIC_PURCHASE_KEY}:item`,
        createdBy:ACTOR_ID,
        forceSeparate:true,
        metadata:{ campaign_key:CAMPAIGN_KEY, return_points_ledger_id:Number(ledger.lastID), repair_operation_key:RELIC_REPAIR_KEY, relic_key:RELIC_TEMPLATE_KEY },
    });
    const item = granted.items[0];
    await db.run('UPDATE clover_seasonal_relic_ownership SET inventory_item_id=? WHERE relic_key=?', [item.id,RELIC_TEMPLATE_KEY]);
    await recordRepair(
        db,RELIC_REPAIR_KEY,APOSTOLO_ID,'relic_ticket_purchase',
        { returnPointsBalance:balance },
        { returnPointsBalance:balance - 1000, returnPointsLedgerId:Number(ledger.lastID), inventoryItemId:Number(item.id) }
    );
    return { duplicate:false, repairOperationKey:RELIC_REPAIR_KEY, returnPointsLedgerId:Number(ledger.lastID), inventoryItemId:Number(item.id) };
}

async function applyPreresetKeepEconomyRepair(db, options = {}) {
    if (options.execute !== true) throw new Error('Aplicacao real exige execute=true.');
    await ensureRepairSchema(db);
    const plan = await planPreresetKeepEconomyRepair(db);
    if (!plan.ok) throw new Error(`Preflight bloqueado: ${JSON.stringify(plan.blockers)}`);
    if (options.expectedPlanHash && options.expectedPlanHash !== plan.planHash) throw new Error('Plano divergiu do preflight.');
    await db.exec('BEGIN IMMEDIATE');
    try {
        for (const player of plan.players.filter((entry) => entry.pending)) {
            const before = { money:player.moneyBefore, items:player.removableItems.map((item) => ({ id:item.id, name:item.itemName, quantity:item.quantity })) };
            if (player.moneyBefore > 0) {
                await spendYullsInTransaction(db, player.playerId, player.moneyBefore, SOURCE,
                    'Reset economico do PRE_RESET para personagem mantido',ACTOR_ID,{
                        relatedId:player.operationKey,
                        idempotencyKey:`${player.operationKey}:yulls`,
                        metadata:{ campaign_key:CAMPAIGN_KEY, preserved_character:true },
                    });
            }
            for (const item of player.removableItems) await archiveInventoryItem(db, player.playerId, item);
            await recordRepair(db,player.operationKey,player.playerId,'keep_economy_cleanup',before,{
                money:0,archivedItemIds:player.removableItems.map((item) => item.id),preservedBoxes:player.boxes,
            });
        }
        const relic = await applyApostoloRelicPurchase(db);
        await db.exec('COMMIT');
        const after = await planPreresetKeepEconomyRepair(db);
        return { ok:true, applied:true, before:plan, relic, after };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    ACTOR_ID,
    APOSTOLO_ID,
    CAMPAIGN_KEY,
    RELIC_PURCHASE_KEY,
    RELIC_REPAIR_KEY,
    RELIC_TEMPLATE_KEY,
    SOURCE,
    applyPreresetKeepEconomyRepair,
    planPreresetKeepEconomyRepair,
};
