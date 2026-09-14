'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { createPreResetPolicyRegistry } = require('../helpers/clover/preResetPolicyRegistryService');
const {
    applyLaunch,
    finalizeRoster,
    replaceKeepRoster,
} = require('../helpers/clover/preResetLaunchService');
const { openReturnPointShop } = require('../helpers/clover/returnPointShopGateService');
const {
    creditReturnPoints,
    debitReturnPoints,
    getReturnPointsBalance,
} = require('../helpers/clover/returnPointsService');

function policyRegistry() {
    return createPreResetPolicyRegistry({
        testOnly: true,
        policies: {
            PRE_RESET_MODE: { status: 'ENABLED', policyVersion: 'fulfillment-mode-v1' },
            SESSION_ELIGIBILITY: {
                status: 'ENABLED',
                policyVersion: 'fulfillment-session-v1',
                eligibleReleasedSessions: true,
            },
        },
    });
}

function adminContext() {
    return {
        actorId: 'admin-return-shop-fulfillment',
        env: {
            PRE_RESET_LAUNCH_ENABLED: 'true',
            PRE_RESET_RETURN_ENABLED: 'true',
            PRE_RESET: 'ON',
        },
        policyRegistry: policyRegistry(),
        capabilities: ['prereset.review', 'player.manage', 'operation.apply'],
    };
}

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-return-shop-fulfillment-'));
    const db = await database.criarBanco({ filename: path.join(dir, 'database.sqlite') });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return db;
}

async function seedResetPlayer(db, playerId) {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, ficha_status, jogo_status, personagem_nome, personagem_aparencia,
          personagem_aparencia_status, dinheiro)
         VALUES (?, ?, 'aprovada', 'liberado', ?, ?, 'approved', ?)`,
        [playerId, `Player ${playerId}`, 'Legacy Yulls', 'Aparencia Legacy Yulls', 777]
    );
}

async function seedKeepPlayers(db, count = 14) {
    const ids = [];
    for (let index = 1; index <= count; index += 1) {
        const playerId = `return-shop-keep-${String(index).padStart(2, '0')}`;
        await seedResetPlayer(db, playerId);
        ids.push(playerId);
    }
    return ids;
}

const {DEFAULT_PRE_RESET_CAMPAIGN_KEY:CAMPAIGN}=require('../helpers/clover/preResetCampaignStateService');
const {applyFutureCharacterMutation}=require('../helpers/clover/preResetCharacterService');
const {fulfillReturnPointShopEconomicEntitlements:fulfill}=require('../helpers/clover/returnPointShopFulfillmentService');
const {purchaseReturnPointShopItem:purchase}=require('../helpers/clover/returnPointShopService');
const {runWithLifecycleContext}=require('../helpers/clover/lifecyclePolicy');
function launch(f,key){return runWithLifecycleContext({env:{PRE_RESET:'ON',PRE_RESET_RETURN_ENABLED:'true'}},()=>applyLaunch(f.db,f.ctx,{operationKey:key}));}

async function prepared(t,quantity,{manual=false}={}){
    const db=await fixture(t); const id='future-ph-player';
    await seedResetPlayer(db,id); const keepPlayerIds=await seedKeepPlayers(db);const ctx=adminContext();
    await replaceKeepRoster(db,ctx,{operationKey:'ph-roster-replace',expectedRevision:0,keepPlayerIds});
    await finalizeRoster(db,ctx,{operationKey:'ph-roster-finalize',expectedRevision:1});
    await openReturnPointShop(db,ctx.actorId);
    // Old-world PH exists before purchase, and must not receive the entitlement.
    await require('../helpers/clover/phService').ensurePhState(db,id);
    const oldLedger=await db.all('SELECT * FROM clover_ph_ledger WHERE player_id=?',[id]);
    if(manual){
        await require('../helpers/clover/returnPointShopManualService').importManualReturnShopObligation(db,{
            playerId:id,operationKey:'ph-import',externalReference:'ph-receipt',source:'fixture',sourceRowId:'ph-row',
            acquiredAt:'2026-07-13T12:00:00Z',actorId:'test',campaignKey:CAMPAIGN,effects:[{itemKey:'ph_1',quantity}],
        });
    }else{
        await creditReturnPoints(db,id,quantity,{operationKey:'ph-credit',source:'fixture',reason:'Synthetic PH purchase',createdBy:'test'});
        await purchase(db,id,{itemKey:'ph_1',quantity,idempotencyKey:'ph-purchase'});
        await purchase(db,id,{itemKey:'ph_1',quantity,idempotencyKey:'ph-purchase'});
    }
    assert.equal((await fulfill(db,id,{campaignKey:CAMPAIGN})).fulfilledCount,0);
    assert.deepEqual(await db.all('SELECT * FROM clover_ph_ledger WHERE player_id=?',[id]),oldLedger);
    await db.run(`INSERT INTO clover_prereset_future_rolls
        (campaign_key,player_id,roll_number,kingdom,social_class,race,grimoire,magic_rarity,summary,roll_version,kingdom_key,social_class_key,race_key,grimoire_key,magic_rarity_key)
        VALUES (?,?,1,'Reino Clover','Plebeu','Humano','Grimorio de 3 Folhas','Incomum','PH fixture','ph-v1','clover','plebeu','humano','clover_3f','incomum')`,[CAMPAIGN,id]);
    await applyFutureCharacterMutation(db,id,id,{operationType:'create',expectedRevision:0,operationKey:'ph-character-create',
        draft:{name:'Future PH',age:19,gender:'Masculino',appearance:'Asta — Black Clover',rollNumber:1,familyKey:'sem_linhagem',magicKey:'magia_de_algodao',entitlementKeys:[],notes:null}});
    await db.run("UPDATE clover_prereset_characters SET status='locked',locked_at=CURRENT_TIMESTAMP WHERE player_id=?",[id]);
    assert.equal((await fulfill(db,id,{campaignKey:CAMPAIGN,promoted:true})).fulfilledCount,0);
    return {db,id,ctx,quantity};
}

async function assertDelivered({db,id,quantity}){
    const stats=await db.get('SELECT ph_available,ph_accumulated FROM clover_character_stats WHERE player_id=?',[id]);
    assert.deepEqual(stats,{ph_available:quantity,ph_accumulated:quantity});
    const entries=await db.all('SELECT * FROM clover_ph_ledger WHERE player_id=?',[id]);assert.equal(entries.length,1);assert.equal(entries[0].amount,quantity);
    assert.equal(entries[0].source,'return_point_shop_fulfillment');
    const right=await db.get('SELECT * FROM clover_prereset_entitlements WHERE player_id=?',[id]);assert.equal(right.status,'consumed');
    const audit=JSON.parse(entries[0].metadata_json);assert.equal(audit.entitlement_id,right.id);assert.equal(audit.campaign_key,CAMPAIGN);assert.equal(audit.quantity,quantity);
    assert.equal(audit.purchase_id,right.purchase_id);assert.equal(audit.manual_import_id,right.manual_import_id);
    assert.equal(entries[0].related_id,'return-shop:entitlement:'+right.id);
    assert.equal((await db.get('SELECT personagem_nome FROM jogadores WHERE id=?',[id])).personagem_nome,'Future PH');
    assert.equal((await fulfill(db,id,{campaignKey:CAMPAIGN})).fulfilledCount,0);
    assert.deepEqual(await db.all('SELECT * FROM clover_ph_ledger WHERE player_id=?',[id]),entries);
}

for(const quantity of [1,7,60]) test(`future PH: ${quantity} units delivered only after canonical launch promotion, exact credit and retry`,async t=>{
    const f=await prepared(t,quantity);const launched=await launch(f,'ph-launch');assert.equal(launched.completed,true);
    await assertDelivered(f);assert.equal((await launch(f,'ph-launch')).duplicate,true);await assertDelivered(f);
});
test('future PH: manual provenance, transactional rollback and launch resume after promotion commit',async t=>{
    const f=await prepared(t,11,{manual:true});
    await f.db.exec("CREATE TRIGGER synthetic_ph_failure BEFORE UPDATE OF status ON clover_prereset_entitlements WHEN NEW.status='consumed' BEGIN SELECT RAISE(ABORT,'synthetic PH consume failure'); END");
    await assert.rejects(launch(f,'ph-launch-resume'),error=>error.code==='launch_interrupted' && /synthetic PH consume failure/.test(error.details.causeMessage));
    assert.equal((await f.db.get('SELECT status FROM clover_prereset_entitlements WHERE player_id=?',[f.id])).status,'active');
    assert.equal((await f.db.get('SELECT COUNT(*) n FROM clover_ph_ledger WHERE player_id=?',[f.id])).n,0);
    assert.equal((await f.db.get('SELECT COUNT(*) n FROM clover_character_stats WHERE player_id=?',[f.id])).n,0);
    assert.equal((await f.db.get('SELECT personagem_nome FROM jogadores WHERE id=?',[f.id])).personagem_nome,'Future PH');
    await f.db.exec('DROP TRIGGER synthetic_ph_failure');
    const resumed=await launch(f,'ph-launch-resume');assert.equal(resumed.completed,true);
    await assertDelivered(f);
    assert.equal((await f.db.get('SELECT COUNT(*) n FROM clover_player_reset_events WHERE player_id=?',[f.id])).n,1);
});

test('launch preserves pending special/custom rights without fallback and delivers only closed Royal',async t=>{
    const f=await prepared(t,1);
    const keys=['ticket_reliquia','eco_vida_passada','coracao_cristal','ryuga','gintetsu','surtr','capibara','item_magico_personalizado','caixa_real'];
    const catalog=require('../helpers/clover/returnPointShopCatalog');
    const total=keys.reduce((n,key)=>n+catalog.getReturnPointShopItem(key).priceReturnPoints,0);
    await creditReturnPoints(f.db,f.id,total,{operationKey:'blockers-credit',source:'fixture',reason:'Synthetic pending rights',createdBy:'test'});
    for(const key of keys)await purchase(f.db,f.id,{itemKey:key,idempotencyKey:'pending-'+key});
    const before=await f.db.all('SELECT id,entitlement_key,metadata_json FROM clover_prereset_entitlements WHERE player_id=? ORDER BY id',[f.id]);
    assert.equal((await launch(f,'pending-rights-launch')).completed,true);
    assert.deepEqual(await f.db.all('SELECT id,entitlement_key,metadata_json FROM clover_prereset_entitlements WHERE player_id=? ORDER BY id',[f.id]),before);
    const rights=await f.db.all('SELECT status,metadata_json FROM clover_prereset_entitlements WHERE player_id=?',[f.id]);
    for(const right of rights){const key=JSON.parse(right.metadata_json).itemKey;assert.equal(right.status,['ph_1','caixa_real'].includes(key)?'consumed':'active',key);}
    const items=await f.db.all('SELECT template_key,quantity FROM clover_inventory_items WHERE player_id=?',[f.id]);assert.deepEqual(items,[{template_key:'box_royal_v1',quantity:1}]);
    await assert.rejects(require('../helpers/clover/boxService').openBox(f.db,f.id,'box_royal_v1',{idempotencyKey:'pending-royal-open'}),{code:'box_loot_table_pending'});
    assert.deepEqual(await f.db.all('SELECT template_key,quantity FROM clover_inventory_items WHERE player_id=?',[f.id]),items);
});
