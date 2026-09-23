'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarBanco } = require('../database');
const inventory = require('../helpers/clover/inventoryService');
const { ensurePreresetManualPurchaseSchema } = require('../helpers/clover/prManualPurchaseImportService');
const { seedSeasonalEventTemplates } = require('../helpers/clover/seasonalEventCatalog');
const service = require('../helpers/clover/preresetKeepEconomyRepairService');

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-keep-economy-repair-'));
    const db = await criarBanco({ filename:path.join(dir, 'test.sqlite') });
    t.after(async () => { await db.close(); fs.rmSync(dir, { recursive:true, force:true }); });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_prereset_launch_players (
            campaign_key TEXT NOT NULL, player_id TEXT NOT NULL, roster_revision INTEGER NOT NULL,
            outcome TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, PRIMARY KEY(campaign_key,player_id)
        );
        CREATE TABLE IF NOT EXISTS clover_seasonal_relic_ownership (
            relic_key TEXT PRIMARY KEY, player_id TEXT NOT NULL, inventory_item_id INTEGER,
            box_opening_id INTEGER NOT NULL UNIQUE, claimed_at TEXT DEFAULT CURRENT_TIMESTAMP, metadata_json TEXT
        );
        CREATE TABLE IF NOT EXISTS clover_return_points_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL,
            entry_kind TEXT NOT NULL,
            operation_key TEXT UNIQUE,
            source TEXT,
            reason TEXT,
            policy_version TEXT,
            reset_cycle_key TEXT,
            related_id TEXT,
            correlation_id TEXT,
            created_by TEXT,
            metadata_json TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await db.run(
        "INSERT INTO jogadores(id,nome,personagem_nome,ficha_status,jogo_status,dinheiro) VALUES (?,'Apostolo','Kurai','aprovada','liberado',12345)",
        [service.APOSTOLO_ID]
    );
    await db.run(
        "INSERT INTO clover_prereset_launch_players VALUES ('mythic_launch_v1',?,1,'keep','completed','2026-09-14 19:33:30')",
        [service.APOSTOLO_ID]
    );
    await inventory.ensureInventoryV1(db);
    await ensurePreresetManualPurchaseSchema(db);
    await seedSeasonalEventTemplates(db);
    await inventory.addCatalogItem(db, service.APOSTOLO_ID, 'box_rare_v1', 2, { source:'fixture', idempotencyKey:'fixture:box' });
    await inventory.addCatalogItem(db, service.APOSTOLO_ID, 'sabre', 1, { source:'fixture', idempotencyKey:'fixture:sabre' });
    await db.run("UPDATE clover_inventory_items SET created_at='2026-09-01 00:00:00' WHERE player_id=?", [service.APOSTOLO_ID]);
    await db.run(
        `INSERT INTO clover_return_points_ledger
         (player_id,amount,entry_kind,operation_key,source,reason,created_by)
         VALUES (?,1500,'credit','fixture:pr','fixture','fixture','fixture')`,
        [service.APOSTOLO_ID]
    );
    return db;
}

test('cleans kept economy, preserves boxes and grants confirmed relic exactly once', async (t) => {
    const db = await fixture(t);
    const beforeName = (await db.get('SELECT personagem_nome FROM jogadores WHERE id=?', [service.APOSTOLO_ID])).personagem_nome;
    const plan = await service.planPreresetKeepEconomyRepair(db);
    assert.equal(plan.ok, true, JSON.stringify(plan.blockers));
    assert.equal(plan.summary.moneyToReset, 12345);
    assert.equal(plan.summary.itemUnitsToArchive, 1);
    assert.equal(plan.summary.boxUnitsPreserved, 2);
    const result = await service.applyPreresetKeepEconomyRepair(db, { execute:true, expectedPlanHash:plan.planHash });
    assert.equal(result.after.summary.pendingPlayers, 0);
    assert.equal(result.after.summary.relicPurchasePending, false);
    const player = await db.get('SELECT personagem_nome,dinheiro FROM jogadores WHERE id=?', [service.APOSTOLO_ID]);
    assert.deepEqual(player, { personagem_nome:beforeName, dinheiro:0 });
    assert.equal((await db.get("SELECT SUM(quantity) total FROM clover_inventory_items WHERE player_id=? AND template_key='box_rare_v1'", [service.APOSTOLO_ID])).total, 2);
    assert.deepEqual(await db.get("SELECT quantity,status FROM clover_inventory_items WHERE player_id=? AND template_key='sabre'", [service.APOSTOLO_ID]), { quantity:1, status:'consumido' });
    assert.equal((await db.get("SELECT SUM(quantity) total FROM clover_inventory_items WHERE player_id=? AND template_key=?", [service.APOSTOLO_ID,service.RELIC_TEMPLATE_KEY])).total, 1);
    assert.equal((await db.get('SELECT player_id FROM clover_seasonal_relic_ownership WHERE relic_key=?', [service.RELIC_TEMPLATE_KEY])).player_id, service.APOSTOLO_ID);
    assert.equal((await db.get('SELECT COALESCE(SUM(amount),0) balance FROM clover_return_points_ledger WHERE player_id=?', [service.APOSTOLO_ID])).balance, 500);
    const counts = {
        repair:(await db.get('SELECT COUNT(*) total FROM clover_prereset_keep_economy_repairs WHERE operation_key=?', [service.RELIC_REPAIR_KEY])).total,
        relic:(await db.get('SELECT COUNT(*) total FROM clover_inventory_items WHERE player_id=? AND template_key=? AND quantity>0', [service.APOSTOLO_ID,service.RELIC_TEMPLATE_KEY])).total,
        debit:(await db.get("SELECT COUNT(*) total FROM clover_return_points_ledger WHERE operation_key=?", [`${service.SOURCE}:apostolo:relic-ticket-debit`])).total,
    };
    await service.applyPreresetKeepEconomyRepair(db, { execute:true, expectedPlanHash:result.after.planHash });
    assert.deepEqual({
        repair:(await db.get('SELECT COUNT(*) total FROM clover_prereset_keep_economy_repairs WHERE operation_key=?', [service.RELIC_REPAIR_KEY])).total,
        relic:(await db.get('SELECT COUNT(*) total FROM clover_inventory_items WHERE player_id=? AND template_key=? AND quantity>0', [service.APOSTOLO_ID,service.RELIC_TEMPLATE_KEY])).total,
        debit:(await db.get("SELECT COUNT(*) total FROM clover_return_points_ledger WHERE operation_key=?", [`${service.SOURCE}:apostolo:relic-ticket-debit`])).total,
    }, counts);
});
