'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarBanco } = require('../database');
const inventory = require('../helpers/clover/inventoryService');
const service = require('../helpers/clover/preresetParticipantRoyalBoxBonusService');

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-participant-boxes-'));
    const db = await criarBanco({ filename:path.join(dir, 'test.sqlite') });
    t.after(async () => { await db.close(); fs.rmSync(dir, { recursive:true, force:true }); });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_prereset_launch_players (
            campaign_key TEXT NOT NULL, player_id TEXT NOT NULL, roster_revision INTEGER NOT NULL,
            outcome TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, PRIMARY KEY(campaign_key,player_id)
        );
        CREATE TABLE IF NOT EXISTS clover_prereset_future_rolls (
            campaign_key TEXT NOT NULL, player_id TEXT NOT NULL, roll_number INTEGER NOT NULL,
            PRIMARY KEY(campaign_key,player_id,roll_number)
        );
    `);
    const playerColumns = new Set((await db.all("PRAGMA table_info('jogadores')")).map((row) => row.name));
    for (const [column,definition] of [
        ['is_shadow','INTEGER NOT NULL DEFAULT 0'],
        ['is_canonical','INTEGER NOT NULL DEFAULT 1'],
        ['lifecycle_status',"TEXT NOT NULL DEFAULT 'active'"],
    ]) {
        if (!playerColumns.has(column)) await db.run(`ALTER TABLE jogadores ADD COLUMN ${column} ${definition}`);
    }
    for (const id of ['keep@lid','roller@lid','late@lid','idle@lid','test@lid']) {
        await db.run(
            `INSERT INTO jogadores(id,nome,personagem_nome,ficha_status,jogo_status,is_test_user)
             VALUES (?,?,?,'incompleta','bloqueado',?)`,
            [id,id,'-',id === 'test@lid' ? 1 : 0]
        );
    }
    for (const [id,outcome] of [['keep@lid','keep'],['roller@lid','reset'],['idle@lid','reset']]) {
        await db.run(
            `INSERT INTO clover_prereset_launch_players
             (campaign_key,player_id,roster_revision,outcome,status,completed_at)
             VALUES ('mythic_launch_v1',?,1,?,'completed','2026-09-14 19:32:11')`,
            [id,outcome]
        );
    }
    await db.run("INSERT INTO clover_prereset_future_rolls VALUES ('mythic_launch_v1','roller@lid',1)");
    await db.run("INSERT INTO clover_prereset_future_rolls VALUES ('mythic_launch_v1','test@lid',1)");
    await db.run(
        `INSERT INTO player_rolls
         (player_id,roll_number,kingdom,social_class,race,grimoire,magic_rarity,created_at)
         VALUES ('late@lid',1,'Clover','Plebeu','Humano','Grimorio de 3 Folhas','Comum','2026-09-15 00:00:00')`
    );
    await inventory.ensureInventoryV1(db);
    await db.run(
        `INSERT OR IGNORE INTO clover_item_templates
         (template_key,catalog_version,item_name,description,category,kind,origin,base_price,
          default_quality,default_durability,stackable,transferable,properties_json,effects_json,
          metadata_json,active,is_custom,requestable,marketable,duplicable,created_by,created_at,updated_at)
         VALUES ('box_royal_v1',1,'Caixa Real','Bonus de teste.','caixa','caixa_retorno_pending',
                 'PRE_RESET',0,'comum',NULL,1,0,'{}','{}','{}',1,0,0,0,1,'test',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
    );
    return db;
}

test('grants two royal boxes only to effective participants and replays safely', async (t) => {
    const db = await fixture(t);
    const plan = await service.planPreresetParticipantRoyalBoxBonus(db);
    assert.equal(plan.ok, true, JSON.stringify(plan.blockers));
    assert.deepEqual(plan.summary, { eligible:3, pending:3, delivered:0, boxesToGrant:6 });
    const result = await service.applyPreresetParticipantRoyalBoxBonus(db, {
        execute:true,
        expectedPlanHash:plan.planHash,
    });
    assert.deepEqual(result.after.summary, { eligible:3, pending:0, delivered:3, boxesToGrant:0 });
    for (const id of ['keep@lid','roller@lid','late@lid']) {
        const row = await db.get(
            "SELECT COALESCE(SUM(quantity),0) total FROM clover_inventory_items WHERE player_id=? AND template_key='box_royal_v1' AND status='disponivel'",
            [id]
        );
        assert.equal(row.total, 2);
    }
    for (const id of ['idle@lid','test@lid']) {
        const row = await db.get(
            "SELECT COALESCE(SUM(quantity),0) total FROM clover_inventory_items WHERE player_id=? AND template_key='box_royal_v1'",
            [id]
        );
        assert.equal(row.total, 0);
    }
    const replay = await service.applyPreresetParticipantRoyalBoxBonus(db, {
        execute:true,
        expectedPlanHash:result.after.planHash,
    });
    assert.equal(replay.after.summary.delivered, 3);
    assert.equal((await db.get(
        'SELECT COUNT(*) total FROM clover_inventory_item_history WHERE source=?',
        [service.OPERATION_KEY]
    )).total, 3);
});
