'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { auditPreresetReleaseGate } = require('../helpers/clover/preresetReleaseGateService');

async function fixture(t, status = 'approved') {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    t.after(() => db.close());
    await db.exec(`
      CREATE TABLE jogadores(id TEXT PRIMARY KEY, personagem_nome TEXT,numero_roll_escolhido INTEGER,esquadrao TEXT);
      CREATE TABLE clover_prereset_characters(player_id TEXT PRIMARY KEY,status TEXT,revision INTEGER,draft_json TEXT);
      CREATE TABLE clover_prereset_future_rolls(campaign_key TEXT,player_id TEXT,roll_number INTEGER,kingdom TEXT,social_class TEXT,race TEXT,grimoire TEXT);
      CREATE TABLE clover_prereset_purchases(id INTEGER PRIMARY KEY,status TEXT,catalog_item_key TEXT,metadata_json TEXT);
      CREATE TABLE clover_prereset_entitlements(id INTEGER PRIMARY KEY,purchase_id INTEGER,player_id TEXT,status TEXT,metadata_json TEXT);
      INSERT INTO jogadores VALUES('p','Antigo',1,'-');
      INSERT INTO clover_prereset_characters VALUES('p','${status}',1,'{"name":"Novo","rollNumber":1}');
      INSERT INTO clover_prereset_future_rolls VALUES('mythic_launch_v1','p',1,'Clover','Miseravel','Humano','3 Folhas');
      INSERT INTO clover_prereset_purchases VALUES(1,'completed','return_shop_normal_package','{}');
      INSERT INTO clover_prereset_entitlements VALUES(1,1,'p','active','{"fulfillment_status":"pending_character_fulfillment","items":[{"key":"rareBox"}]}');
    `);
    return db;
}

test('aceita ficha aprovada e entrega materializavel no launch', async t => {
    const result = await auditPreresetReleaseGate(await fixture(t));
    assert.equal(result.ok, true);
    assert.equal(result.verdict, 'READY_FOR_CONTROLLED_LAUNCH');
    assert.equal(result.shop.stageableAtLaunch, 1);
});

test('bloqueia ficha ainda submetida', async t => {
    const result = await auditPreresetReleaseGate(await fixture(t, 'submitted'));
    assert.equal(result.ok, false);
    assert.equal(result.blockers[0].code, 'sheet_waiting_review');
});

test('compra sem roll de jogador em rascunho nao bloqueia quem esta pronto', async t => {
    const db = await fixture(t);
    await db.run("INSERT INTO jogadores VALUES('draft','- ',NULL,'-')");
    await db.run("INSERT INTO clover_prereset_characters VALUES('draft','draft',1,'{}')");
    await db.run("INSERT INTO clover_prereset_purchases VALUES(2,'completed','return_shop_global_package','{}')");
    await db.run("INSERT INTO clover_prereset_entitlements VALUES(2,2,'draft','active','{\"fulfillment_status\":\"pending_roll_assignment\",\"requires_roll_assignment\":true}')");
    const result = await auditPreresetReleaseGate(db);
    assert.equal(result.ok, true);
    assert.equal(result.shop.deferredWithDrafts, 1);
});
