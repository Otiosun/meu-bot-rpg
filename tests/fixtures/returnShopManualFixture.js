'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarBanco } = require('../../database');
const service = require('../../helpers/clover/returnPointShopManualService');
const CAMPAIGN = 'mythic_launch_v1';
async function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'clover-manual-shop-'));
    const db = await criarBanco({filename:path.join(directory,'database.sqlite')});
    t.after(async () => { await db.close(); fs.rmSync(directory,{recursive:true,force:true}); });
    await db.run(`INSERT INTO clover_prereset_launch_rosters(campaign_key,revision,status,roster_hash,finalized_by,finalized_at)
        VALUES (?,1,'finalized','synthetic','test',CURRENT_TIMESTAMP)`,[CAMPAIGN]);
    for (const playerId of ['manual-owner','manual-other']) {
        await db.run("INSERT INTO jogadores(id,nome,personagem_nome,ficha_status) VALUES (?,'Synthetic','Old Character','aprovada')",[playerId]);
        await db.run("INSERT INTO clover_prereset_launch_players(campaign_key,player_id,roster_revision,outcome,status) VALUES (?,?,1,'reset','pending')",[CAMPAIGN,playerId]);
        for (const number of [1,2]) await db.run(`INSERT INTO clover_prereset_future_rolls
            (campaign_key,player_id,roll_number,kingdom,social_class,race,grimoire,magic_rarity,summary,roll_version,kingdom_key,social_class_key,race_key,grimoire_key)
            VALUES (?,?,?,'Clover','Miseravel','Humano','Three Leaves','Comum','Synthetic','test','clover','miseravel','humano','clover_3f')`,[CAMPAIGN,playerId,number]);
    }
    return db;
}
function imported(overrides={}) {
    return {playerId:'manual-owner',operationKey:'import-one',externalReference:'historical-receipt-one',source:'approved-checkpoint',sourceRowId:'row-one',
        acquiredAt:'2026-07-13T12:00:00Z',actorId:'test-admin',campaignKey:CAMPAIGN,effects:[{itemKey:'yulls_5000'}],...overrides};
}
function assigned(importId,overrides={}) {
    return {importId,playerId:'manual-owner',campaignKey:CAMPAIGN,targetRollNumber:1,actorId:'test-admin',operationKey:'assign-one',...overrides};
}
module.exports = {fixture,imported,assigned,CAMPAIGN,service};
