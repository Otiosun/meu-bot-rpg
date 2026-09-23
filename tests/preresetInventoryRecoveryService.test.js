'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { criarBanco } = require('../database');
const inventory = require('../helpers/clover/inventoryService');
const { ensurePreresetManualPurchaseSchema } = require('../helpers/clover/prManualPurchaseImportService');
const service = require('../helpers/clover/preresetInventoryRecoveryService');

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-inventory-recovery-'));
    const db = await criarBanco({ filename:path.join(dir, 'test.sqlite') });
    const playerId = `inventory-recovery-${crypto.randomUUID()}`;
    t.after(async () => { await db.close(); fs.rmSync(dir, { recursive:true, force:true }); });
    await ensurePreresetManualPurchaseSchema(db);
    await db.exec(`
        CREATE TABLE clover_prereset_launch_players (
            campaign_key TEXT NOT NULL,
            player_id TEXT NOT NULL,
            roster_revision INTEGER NOT NULL,
            outcome TEXT NOT NULL,
            status TEXT NOT NULL
        );
        CREATE TABLE clover_return_shop_custom_requests (
            entitlement_id INTEGER PRIMARY KEY,
            player_id TEXT NOT NULL,
            campaign_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            description TEXT DEFAULT NULL
        );
    `);
    await db.run("INSERT INTO jogadores(id,nome,personagem_nome,ficha_status,jogo_status) VALUES (?,'Reset','Novo','aprovada','liberado')", [playerId]);
    await db.run("INSERT INTO clover_prereset_launch_players(campaign_key,player_id,roster_revision,outcome,status) VALUES ('mythic_launch_v1',?,1,'reset','completed')", [playerId]);
    await inventory.ensureInventoryV1(db);
    const old = await inventory.addCatalogItem(db, playerId, 'box_rare_v1', 1, { source:'fixture_old_box', idempotencyKey:`fixture-old-box:${playerId}` });
    await db.run('DELETE FROM clover_inventory_items WHERE id=?', [old.items[0].id]);
    const purchase = await db.run("INSERT INTO clover_prereset_purchases(player_id,idempotency_key,catalog_item_key,entitlement_key,price_return_points,return_points_ledger_id,status,metadata_json) VALUES (? ,?,'return_shop_normal_package',?,0,1,'completed','{\"test_only_prereset_shop_gate_bypass\":1}')", [playerId, `fixture-package:${playerId}`, `fixture-right:${playerId}`]);
    const metadata = {
        fulfillment_status:'pending_character_fulfillment', requires_roll_assignment:false,
        items:[
            { key:'rareBox', quantity:1 }, { key:'royalBox', quantity:2 }, { key:'spellTicket', quantity:1 },
            { key:'ph', quantity:3 }, { key:'yulls20k', quantity:1 }, { key:'bindings', quantity:1 },
            { key:'customMagicItem', quantity:1 },
        ],
    };
    await db.run("INSERT INTO clover_prereset_entitlements(player_id,entitlement_key,purchase_id,status,metadata_json) VALUES (?,?,?,'active',?)", [playerId, `fixture-right:${playerId}`, purchase.lastID, JSON.stringify(metadata)]);
    return { db, playerId };
}

test('restores reset boxes and fulfills legacy economic package exactly once', async (t) => {
    const { db, playerId } = await fixture(t);
    const plan = await service.planPreresetInventoryRecovery(db);
    assert.equal(plan.ok, true);
    assert.equal(plan.summary.boxes.box_rare_v1, 1);
    const result = await service.applyPreresetInventoryRecovery(db, { execute:true, expectedPlanHash:plan.planHash });
    assert.equal(result.after.summary.shopActions, 0);
    const quantities = Object.fromEntries((await db.all("SELECT template_key,SUM(quantity) quantity FROM clover_inventory_items WHERE player_id=? GROUP BY template_key", [playerId])).map((row) => [row.template_key, Number(row.quantity)]));
    assert.equal(quantities.box_rare_v1, 2);
    assert.equal(quantities.box_royal_v1, 2);
    assert.equal(quantities.ticket_feitico, 1);
    assert.equal(quantities.return_shop_amarras_coracao, 1);
    assert.equal((await db.get("SELECT COALESCE(SUM(amount),0) total FROM clover_ph_ledger WHERE player_id=? AND source=?", [playerId, service.SOURCE])).total, 3);
    assert.equal((await db.get("SELECT COALESCE(SUM(amount),0) total FROM clover_yulls_ledger WHERE player_id=? AND source=?", [playerId, service.SOURCE])).total, 20000);
    assert.equal((await db.get('SELECT COUNT(*) total FROM clover_return_shop_custom_requests')).total, 1);
    const legacyEntitlement = await db.get('SELECT status,metadata_json FROM clover_prereset_entitlements WHERE purchase_id=?', [1]);
    assert.equal(legacyEntitlement.status, 'active');
    assert.deepEqual(JSON.parse(legacyEntitlement.metadata_json).items.map((item) => item.key), ['customMagicItem']);
    const customEntitlement = await db.get(
        `SELECT e.status,e.metadata_json,p.catalog_item_key
           FROM clover_prereset_entitlements e JOIN clover_prereset_purchases p ON p.id=e.purchase_id
          WHERE p.catalog_item_key='item_magico_personalizado'`
    );
    assert.equal(customEntitlement.status, 'active');
    assert.equal(customEntitlement.catalog_item_key, 'item_magico_personalizado');
    assert.equal(JSON.parse(customEntitlement.metadata_json).effectKind, 'future_item_request');
    const before = await db.get('SELECT COUNT(*) total FROM clover_prereset_inventory_repair_units');
    const replay = await service.applyPreresetInventoryRecovery(db, { execute:true, expectedPlanHash:result.after.planHash });
    assert.equal(replay.after.summary.shopActions, 0);
    assert.deepEqual(await db.get('SELECT COUNT(*) total FROM clover_prereset_inventory_repair_units'), before);
});
