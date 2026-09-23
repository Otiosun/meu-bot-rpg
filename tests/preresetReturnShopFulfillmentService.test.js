'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { applyReturnShopRollFulfillment, previewReturnShopRollFulfillment, buildFulfilledRoll } = require('../helpers/clover/preresetReturnShopFulfillmentService');
const { assignReturnShopEntitlementToRoll } = require('../helpers/clover/preresetReturnShopAssignmentService');

async function setup(t, future = false) {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    t.after(() => db.close());
    await db.exec(`
        CREATE TABLE jogadores (id TEXT PRIMARY KEY, personagem_nome TEXT DEFAULT '-');
        CREATE TABLE player_rolls (
            player_id TEXT NOT NULL, roll_number INTEGER NOT NULL,
            kingdom TEXT DEFAULT '-', social_class TEXT DEFAULT '-', family TEXT DEFAULT '-',
            race TEXT DEFAULT '-', grimoire TEXT DEFAULT '-', grimoire_rank TEXT DEFAULT '-',
            grimoire_symbol TEXT DEFAULT '-', magic_rarity TEXT DEFAULT '-', magic_scope TEXT DEFAULT '-',
            summary TEXT DEFAULT '-', roll_version TEXT DEFAULT 'clover_base_v2',
            kingdom_key TEXT, social_class_key TEXT, race_key TEXT, grimoire_key TEXT,
            magic_rarity_key TEXT, roll_payload TEXT DEFAULT '{}', PRIMARY KEY(player_id, roll_number)
        );
        CREATE TABLE clover_prereset_purchases (
            id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE, catalog_item_key TEXT NOT NULL,
            entitlement_key TEXT NOT NULL, price_return_points INTEGER NOT NULL CHECK(price_return_points > 0),
            return_points_ledger_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'completed',
            metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE clover_prereset_entitlements (
            id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL, entitlement_key TEXT NOT NULL,
            purchase_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',
            metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT CURRENT_TIMESTAMP, consumed_at TEXT
        );
        CREATE TABLE clover_trait_attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL, attempt_number INTEGER NOT NULL,
            category TEXT CHECK(category IN ('rare_aptitude','rare_mark','anomaly')),
            status TEXT DEFAULT 'completed', result TEXT CHECK(result IN ('success','failure')),
            chosen_key TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(player_id, attempt_number)
        );
        INSERT INTO jogadores(id) VALUES ('player@lid');
        INSERT INTO player_rolls(player_id, roll_number, kingdom, kingdom_key, social_class, social_class_key,
            race, race_key, grimoire, grimoire_key, magic_rarity, magic_rarity_key)
        VALUES ('player@lid', 2, 'Spade', 'spade', 'Plebeu', 'plebeu', 'Humano', 'humano',
            'Grimorio de 1 Espada', 'spade_3f', 'Rara', 'rara');
    `);
    if (future) await db.exec(`
        CREATE TABLE clover_prereset_future_rolls AS SELECT 'mythic_launch_v1' campaign_key, * FROM player_rolls;
        INSERT INTO clover_prereset_future_rolls SELECT 'other_campaign', * FROM player_rolls;
        CREATE TABLE clover_prereset_characters (campaign_key TEXT, player_id TEXT, status TEXT);
    `);
    return db;
}

async function addPurchase(db, key, items, categories = [], requires = true) {
    const metadata = JSON.stringify({ items: items.map(key => ({key, label:key, quantity:1})),
        exclusive_categories: categories, requires_roll_assignment: requires,
        fulfillment_status: requires ? 'pending_roll_assignment' : 'pending_character_fulfillment',
        target_roll_number: null });
    const purchase = await db.run(`INSERT INTO clover_prereset_purchases
        (player_id,idempotency_key,catalog_item_key,entitlement_key,price_return_points,return_points_ledger_id,metadata_json)
        VALUES ('player@lid',?,'return_shop_global_package',?,100,1,?)`, [key,`return_shop_package:${key}`,metadata]);
    await db.run(`INSERT INTO clover_prereset_entitlements(player_id,entitlement_key,purchase_id,metadata_json)
        VALUES ('player@lid',?,?,?)`, [`return_shop_package:${key}`,purchase.lastID,metadata]);
}
const apply = db => applyReturnShopRollFulfillment(db,{playerId:'player@lid', requireAllAssigned:true});
const choose = (db,index=1,roll=2) => assignReturnShopEntitlementToRoll(db,'player@lid',index,roll);

test('reino comprado projeta grimorio basico sem criar outra compra',async t=>{
    const db=await setup(t,true);
    await addPurchase(db,'heart-only',['heart'],['reino']);await choose(db);
    const before=await db.get('SELECT COUNT(*) count FROM clover_prereset_purchases');
    const entry=(await previewReturnShopRollFulfillment(db,{playerId:'player@lid'})).ready[0];
    const roll=buildFulfilledRoll(entry,entry.roll).roll;
    assert.equal(roll.kingdom_key,'heart');assert.equal(roll.grimoire_key,'heart_3f');
    assert.deepEqual(await db.get('SELECT COUNT(*) count FROM clover_prereset_purchases'),before);
});

test('reino comprado converte raca incompatível nao comprada em humano',async t=>{
    const db=await setup(t,true);
    await db.run("UPDATE clover_prereset_future_rolls SET race_key='bruxa',race='Bruxa',social_class_key='nao_se_aplica' WHERE campaign_key='mythic_launch_v1'");
    await addPurchase(db,'heart-human',['heart'],['reino']);await choose(db);
    const entry=(await previewReturnShopRollFulfillment(db,{playerId:'player@lid'})).ready[0];
    const roll=buildFulfilledRoll(entry,entry.roll).roll;
    assert.equal(roll.race_key,'humano');assert.notEqual(roll.social_class_key,'nao_se_aplica');
});

test('adaptacao do reino preserva grimorio comprado em pacote separado, independente da ordem',async t=>{
    for(const order of [['doubleHeart','heart'],['heart','doubleHeart']]) {
        const db=await setup(t,true);
        for (let i=0;i<order.length;i++){await addPurchase(db,'split'+i,[order[i]],[order[i]==='heart'?'reino':'grimorio']);await choose(db,i+1);}
        const entries=(await previewReturnShopRollFulfillment(db,{playerId:'player@lid'})).ready;
        let roll=entries[0].roll;
        for(const entry of entries) roll=buildFulfilledRoll(entry,roll,{purchasedFields:['kingdom','grimoire']}).roll;
        assert.equal(roll.grimoire_key,'heart_4f');
    }
});

test('reino nao apaga raca comprada incompatível; transacao e consumo permanecem intactos',async t=>{
    const db=await setup(t,true);
    await addPurchase(db,'paid-witch',['witch'],['raca']);await choose(db,1);
    await addPurchase(db,'paid-heart',['heart'],['reino']);await choose(db,2);
    await assert.rejects(apply(db),e=>e.code==='kingdom_race_conflict');
    assert.equal((await db.get("SELECT COUNT(*) count FROM clover_prereset_entitlements WHERE status='consumed'")).count,0);
});

test('legacy: aplica reino e elfo uma vez sem repetir consumo', async t => {
    const db = await setup(t);
    await addPurchase(db,'sofia',['clover','elf'],['reino','raca']);
    await choose(db);
    assert.equal((await apply(db)).fulfilled.length,1);
    const roll = await db.get('SELECT * FROM player_rolls');
    assert.equal(roll.kingdom_key,'clover');
    assert.equal(roll.race_key,'elfo');
    assert.equal(roll.social_class_key,'nao_se_aplica');
    assert.ok(roll.summary.includes('Clover'));
    const e = await db.get('SELECT * FROM clover_prereset_entitlements');
    assert.equal(e.status,'consumed');
    assert.equal(JSON.parse(e.metadata_json).fulfilled_roll_number,2);
    assert.equal((await apply(db)).fulfilled.length,0);
});

test('legacy: traco raro concede tentativa bem sucedida sem escolha inventada', async t => {
    const db = await setup(t);
    await addPurchase(db,'trait',['rareTrait']);
    await choose(db);
    await apply(db);
    const row = await db.get('SELECT * FROM clover_trait_attempts');
    assert.equal(row.attempt_number,1);
    assert.equal(row.category,'rare_aptitude');
    assert.equal(row.result,'success');
    assert.equal(row.chosen_key,null);
});

test('pacote misto mantem caixa pendente sem categoria ou destino fantasma', async t => {
    const db = await setup(t);
    await addPurchase(db,'mixed',['miserable','royalBox'],['classe_social']);
    await choose(db);
    await apply(db);
    assert.equal((await db.get('SELECT social_class_key FROM player_rolls')).social_class_key,'miseravel_marginal');
    const e = await db.get('SELECT * FROM clover_prereset_entitlements');
    const m = JSON.parse(e.metadata_json);
    assert.equal(e.status,'active');
    assert.deepEqual(m.items.map(i=>i.key),['royalBox']);
    assert.deepEqual(m.exclusive_categories,[]);
    assert.equal(m.requires_roll_assignment,false);
    assert.equal(m.target_roll_number,null);
    const again = await apply(db);
    assert.equal(again.fulfilled.length,0);
    assert.equal(again.pendingCharacter.length,1);
    assert.equal(again.pendingAssignment.length,0);
    assert.equal(again.complete,true);
});

test('caixa sem modificador fica para o personagem', async t => {
    const db = await setup(t);
    await addPurchase(db,'box',['royalBox'],[],false);
    const result = await previewReturnShopRollFulfillment(db,{playerId:'player@lid'});
    assert.equal(result.ready.length,0);
    assert.equal(result.pendingCharacter.length,1);
});

test('finalizacao incompleta nao aplica parte das compras', async t => {
    const db = await setup(t);
    await addPurchase(db,'realm',['clover'],['reino']);
    await addPurchase(db,'grimoire',['fourLeaves'],['grimorio']);
    await choose(db);
    const result = await apply(db);
    assert.equal(result.applied,false);
    assert.equal(result.incomplete,true);
    assert.equal(result.ready.length,1);
    assert.equal(result.pendingAssignment.length,1);
    assert.equal((await db.get('SELECT kingdom_key FROM player_rolls')).kingdom_key,'spade');
    assert.equal((await db.get("SELECT COUNT(*) n FROM clover_prereset_entitlements WHERE status='active'")).n,2);
});

test('aplica apenas ao roll futuro da campanha correta e e idempotente', async t => {
    const db = await setup(t,true);
    await addPurchase(db,'royal',['realeza'],['classe_social']);
    await choose(db);
    await apply(db);
    assert.equal((await db.get("SELECT social_class_key FROM clover_prereset_future_rolls WHERE campaign_key='mythic_launch_v1'")).social_class_key,'realeza');
    assert.equal((await db.get("SELECT social_class_key FROM clover_prereset_future_rolls WHERE campaign_key='other_campaign'")).social_class_key,'plebeu');
    assert.equal((await db.get('SELECT social_class_key FROM player_rolls')).social_class_key,'plebeu');
    assert.equal((await apply(db)).fulfilled.length,0);
});

test('ficha enviada apos escolher bloqueia consumo e mudanca no roll', async t => {
    const db = await setup(t,true);
    await addPurchase(db,'royal',['realeza'],['classe_social']);
    await choose(db);
    await db.run("INSERT INTO clover_prereset_characters VALUES ('mythic_launch_v1','player@lid','submitted')");
    await assert.rejects(apply(db),{code:'future_character_locked'});
    assert.equal((await db.get('SELECT status FROM clover_prereset_entitlements')).status,'active');
});

test('grimorio comprado nao concede reino gratuito ao roll futuro', async t => {
    const db = await setup(t,true);
    await addPurchase(db,'4f',['fourLeaves'],['grimorio']);
    await choose(db);
    await assert.rejects(apply(db),{code:'kingdom_grimoire_conflict'});
    assert.equal((await db.get("SELECT grimoire_key FROM clover_prereset_future_rolls WHERE campaign_key='mythic_launch_v1'")).grimoire_key,'spade_3f');
    assert.equal((await db.get('SELECT status FROM clover_prereset_entitlements')).status,'active');
});

test('compras divididas entre dois rolls nao sao consumidas', async t => {
    const db = await setup(t,true);
    await db.run("UPDATE clover_prereset_future_rolls SET campaign_key='mythic_launch_v1', roll_number=1 WHERE campaign_key='other_campaign'");
    await addPurchase(db,'royal',['realeza'],['classe_social']);
    await addPurchase(db,'trait',['rareTrait']);
    await choose(db,1,1);
    await choose(db,2,2);
    await assert.rejects(apply(db),{code:'return_shop_multiple_rolls'});
    assert.equal((await db.get("SELECT COUNT(*) n FROM clover_prereset_entitlements WHERE status='active'")).n,2);
});

test('anao de Spade pode receber traco comprado sem mudar probabilidades ou outros rolls', async t => {
    const db = await setup(t,true);
    await db.run("UPDATE clover_prereset_future_rolls SET race_key='anao',social_class_key='nao_se_aplica' WHERE campaign_key='mythic_launch_v1'");
    await addPurchase(db,'trait',['rareTrait']);
    await choose(db);
    assert.equal((await apply(db)).fulfilled.length,1);
    assert.equal((await db.get('SELECT COUNT(*) n FROM clover_trait_attempts')).n,0);
});

test('bruxa de Spade continua sendo combinacao invalida para entrega', async t => {
    const db = await setup(t,true);
    await db.run("UPDATE clover_prereset_future_rolls SET race_key='bruxa',social_class_key='nao_se_aplica' WHERE campaign_key='mythic_launch_v1'");
    await addPurchase(db,'trait',['rareTrait']);
    await choose(db);
    await assert.rejects(apply(db),{code:'kingdom_race_conflict'});
    assert.equal((await db.get('SELECT status FROM clover_prereset_entitlements')).status,'active');
});

test('comando explica ficha travada ao jogador sem falha silenciosa', async t => {
    const db = await setup(t,true);
    await addPurchase(db,'royal',['realeza'],['classe_social']);
    await choose(db);
    await db.run("INSERT INTO clover_prereset_characters VALUES ('mythic_launch_v1','player@lid','submitted')");
    const messages = [];
    await require('../comandos/pr').executar({
        db,idJogador:'player@lid',idChat:'test@g.us',body:'finalizar compras',m:{key:{id:'test'}},
        sock:{sendMessage:async (id,message)=>{messages.push(message.text);return {key:{id:'test'}};}},
    });
    assert.equal(messages.length,1);
    assert.match(messages[0],/ficha/i);
    assert.equal((await db.get('SELECT status FROM clover_prereset_entitlements')).status,'active');
});
