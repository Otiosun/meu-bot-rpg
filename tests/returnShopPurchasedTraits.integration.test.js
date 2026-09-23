'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {open} = require('sqlite');
const sqlite3 = require('sqlite3');
const runtime = process.env.CLOVER_RUNTIME_ROOT;
const run = runtime ? test : test.skip;

run('ficha aceita anao de Spade e elfo de Heart, sem aceitar bruxa de Spade', () => {
    const {validatePurchasedRollComposition:validate} = require(path.join(runtime,'comandos/fichanova'));
    const roll = {kingdom_key:'spade',grimoire_key:'spade_3f',race_key:'anao',social_class_key:'nao_se_aplica'};
    assert.deepEqual(validate(roll),[]);
    assert.deepEqual(validate({...roll,kingdom_key:'heart',grimoire_key:'heart_3f',race_key:'elfo'}),[]);
    assert.ok(validate({...roll,race_key:'bruxa'}).length > 0);
});

run('traco consumido vale somente para roll e campanha da entrega', async t => {
    const db = await open({filename:':memory:',driver:sqlite3.Database});
    t.after(()=>db.close());
    await db.exec(`CREATE TABLE jogadores(id TEXT);
        INSERT INTO jogadores VALUES ('player@lid');
        CREATE TABLE clover_prereset_purchases(id INTEGER,status TEXT);
        INSERT INTO clover_prereset_purchases VALUES (1,'completed');
        CREATE TABLE clover_prereset_entitlements(player_id TEXT,purchase_id INTEGER,status TEXT,metadata_json TEXT);`);
    const metadata = {fulfillment_status:'fulfilled',fulfilled_roll_number:2,target_campaign_key:'mythic_launch_v1',
        fulfillment_result:{trait_attempts:[{category:'anomaly'}]}};
    await db.run('INSERT INTO clover_prereset_entitlements VALUES (?,1,?,?)',['player@lid','consumed',JSON.stringify(metadata)]);
    const {getReturnPointTraitEntitlements:get} = require(path.join(runtime,'helpers/clover/returnPointShopTraitEntitlement'));
    assert.equal((await get(db,'player@lid',2)).anomaly,true);
    assert.equal((await get(db,'player@lid',1)).anomaly,false);
    metadata.target_campaign_key='other_campaign';
    await db.run('UPDATE clover_prereset_entitlements SET metadata_json=?',JSON.stringify(metadata));
    assert.equal((await get(db,'player@lid',2)).anomaly,false);
});
