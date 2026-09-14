'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { CURRENT_SCHEMA_MIGRATIONS } = require('../helpers/clover/schemaMigrationPlan');
const { createPreResetPolicyRegistry } = require('../helpers/clover/preResetPolicyRegistryService');
const {
    applyLaunch,
    configurePrPvPolicy,
    finalizeRoster,
    previewLaunchEconomy,
    previewRoster,
    replaceKeepRoster,
    resetForLaunch,
} = require('../helpers/clover/preResetLaunchService');
const {
    assertFutureLaunchReady,
    promoteFutureAfterReset,
} = require('../helpers/clover/preResetFuturePromotionService');
const { applyFutureCharacterMutation } = require('../helpers/clover/preResetCharacterService');
const { DEFAULT_PRE_RESET_CAMPAIGN_KEY } = require('../helpers/clover/preResetCampaignStateService');
const { creditPv, getPvBalance } = require('../helpers/clover/pvService');
const { adminAdjustPr, getPrBalance } = require('../helpers/clover/prService');
const { addCatalogItem, ensureInventoryV1 } = require('../helpers/clover/inventoryService');
const { seedSeasonalEventTemplates } = require('../helpers/clover/seasonalEventCatalog');

function policyRegistry() {
    return createPreResetPolicyRegistry({ testOnly:true, policies:{
        PRE_RESET_MODE:{ status:'ENABLED', policyVersion:'f10-mode-v1' },
        SESSION_ELIGIBILITY:{ status:'ENABLED', policyVersion:'f10-session-v1', eligibleReleasedSessions:true },
    }});
}
function adminContext(preReset = 'OFF') {
    return {
        actorId:'admin-f10',
        env:{ PRE_RESET_LAUNCH_ENABLED:'true', PRE_RESET_RETURN_ENABLED:'true', PRE_RESET:preReset },
        policyRegistry:policyRegistry(),
        capabilities:['prereset.review','player.manage','operation.apply'],
    };
}
async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'clover-f10-'));
    const db = await database.criarBanco({ filename:path.join(dir,'database.sqlite') });
    t.after(async () => { await db.close(); fs.rmSync(dir,{recursive:true,force:true}); });
    return db;
}
async function player(db,id,name) {
    await db.run(
        `INSERT INTO jogadores
         (id,nome,ficha_status,jogo_status,personagem_nome,personagem_aparencia,personagem_aparencia_status)
         VALUES (?,?,'aprovada','liberado',?,?,'approved')`,
        [id,`Player ${id}`,name,`Aparencia ${name}`]
    );
}

test('F10: migrations 0039-0042 permanecem registradas em ordem com extensoes posteriores', () => {
    assert.deepEqual(CURRENT_SCHEMA_MIGRATIONS.filter(m=>m.version>=39 && m.version<=42).map(m=>m.version), [39,40,41,42]);
    assert.equal(CURRENT_SCHEMA_MIGRATIONS.find(m=>m.version===42).key, '0042_return_point_shop_eligibility_snapshot');
});

test('F10: whitelist ADM e autoridade unica; ausente vira reset e roster finalizado congela', async (t) => {
    const db = await fixture(t);
    await player(db,'f10-keep','Keep');
    await player(db,'f10-reset','Reset');
    const ctx = adminContext();
    const replaced = await replaceKeepRoster(db,ctx,{
        operationKey:'f10:roster:replace:0001', expectedRevision:0, keepPlayerIds:['f10-keep'],
    });
    assert.deepEqual(replaced.counts,{ eligible:2, keep:1, reset:1 });
    assert.equal((await previewRoster(db)).players.find((p)=>p.playerId==='f10-keep').outcome,'keep');
    assert.equal((await previewRoster(db)).players.find((p)=>p.playerId==='f10-reset').outcome,'reset');
    await assert.rejects(
        replaceKeepRoster(db,ctx,{ operationKey:'f10:roster:stale:0001', expectedRevision:0, keepPlayerIds:[] }),
        (error)=>error?.code === 'roster_revision_conflict'
    );
    await finalizeRoster(db,ctx,{
        operationKey:'f10:roster:finalize:0001', expectedRevision:1,
    });
    await assert.rejects(
        replaceKeepRoster(db,ctx,{ operationKey:'f10:roster:late:0001', expectedRevision:1, keepPlayerIds:[] }),
        (error)=>error?.code === 'roster_finalized'
    );
});

test('F10: preserva PV e caixas, converte PR uma vez e reseta somente fora da whitelist', async (t) => {
    const db = await fixture(t);
    await player(db,'f10-k','Keep K');
    await player(db,'f10-r','Reset R');
    await ensureInventoryV1(db);
    await seedSeasonalEventTemplates(db);
    await addCatalogItem(db,'f10-r','box_simple_v1',1,{ source:'f10_fixture', createdBy:'admin-f10' });
    await addCatalogItem(db,'f10-r','pocao_cura_basica',1,{ source:'f10_fixture', createdBy:'admin-f10' });
    await creditPv(db,'f10-r',7,{
        operationKey:'f10:pv:legacy:0001', source:'fixture_existing_pv', reason:'PV preexistente', createdBy:'admin-f10',
    });
    await adminAdjustPr(db,'f10-r',10,'PR legado fixture','admin-f10',{ idempotencyKey:'f10:legacy-pr:0001' });

    const ctxOff = adminContext('OFF');
    await replaceKeepRoster(db,ctxOff,{ operationKey:'f10:roster:replace:0002', expectedRevision:0, keepPlayerIds:['f10-k'] });
    await finalizeRoster(db,ctxOff,{ operationKey:'f10:roster:finalize:0002', expectedRevision:1 });
    const economyBefore = await previewLaunchEconomy(db);
    assert.equal(economyBefore.blockedByConversionPolicy,true);
    await assert.rejects(applyLaunch(db,ctxOff,{ operationKey:'f10:apply:0001' }), (error)=>error?.code === 'prereset_real_apply_disabled');

    await configurePrPvPolicy(db,ctxOff,{
        operationKey:'f10:policy:fixture:0001', policyVersion:'TEST_ONLY_1_TO_1', numerator:1, denominator:1, rounding:'floor',
    });
    assert.equal((await previewLaunchEconomy(db)).blockedByConversionPolicy,false);

    const applied = await applyLaunch(db,adminContext('ON'),{ operationKey:'f10:apply:0001' });
    assert.equal(applied.completed,true);
    assert.equal((await db.get("SELECT personagem_nome FROM jogadores WHERE id='f10-k'")).personagem_nome,'Keep K');
    const resetPlayer = await db.get("SELECT personagem_nome,ficha_status,jogo_status FROM jogadores WHERE id='f10-r'");
    assert.deepEqual(resetPlayer,{ personagem_nome:'-', ficha_status:'incompleta', jogo_status:'bloqueado' });
    assert.equal(await getPvBalance(db,'f10-r'),17);
    assert.equal(await getPrBalance(db,'f10-r'),0);
    assert.equal((await db.get("SELECT COUNT(*) AS total FROM clover_inventory_items WHERE player_id='f10-r' AND template_key='box_simple_v1'")).total,1);
    assert.equal((await db.get("SELECT COUNT(*) AS total FROM clover_inventory_items WHERE player_id='f10-r' AND template_key='pocao_cura_basica'")).total,0);
    assert.equal((await db.get("SELECT COUNT(*) AS total FROM clover_prereset_pr_pv_claims WHERE player_id='f10-r'")).total,1);
    const replay = await applyLaunch(db,adminContext('ON'),{ operationKey:'f10:apply:0001' });
    assert.equal(replay.duplicate,true);
    assert.equal(await getPvBalance(db,'f10-r'),17);
});

test('F10: retry apos reset e promocao commitados converge sem resetar ou consumir vaga duas vezes', async (t) => {
    const db = await fixture(t);
    const playerId = 'f10-resume';
    const resetCode = 'RS-F10-RESUME-0001';
    const resetReason = `launch reset ${DEFAULT_PRE_RESET_CAMPAIGN_KEY}: fora da whitelist administrativa`;
    await player(db,playerId,'Legacy Resume');

    await db.run(
        `INSERT INTO clover_prereset_future_rolls
         (campaign_key,player_id,roll_number,kingdom,social_class,family,race,grimoire,grimoire_rank,grimoire_symbol,
          magic_rarity,magic_scope,summary,roll_version,kingdom_key,social_class_key,race_key,grimoire_key,magic_rarity_key,roll_payload)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
            DEFAULT_PRE_RESET_CAMPAIGN_KEY,playerId,1,'Reino Clover','Plebeu',null,'Elfo','Grimorio de 3 Folhas','3-folhas','trevo',
            'Incomum','base','fixture resume','resume-v1','clover','plebeu','elfo','fixture_3f','incomum','{}',
        ]
    );
    await db.run(
        `INSERT INTO clover_prereset_future_slot_reservations
         (campaign_key,player_id,roll_number,category,option_key,status,source)
         VALUES (?,?,1,'race','elfo','held','test_resume')`,
        [DEFAULT_PRE_RESET_CAMPAIGN_KEY,playerId]
    );
    const created = await applyFutureCharacterMutation(db,playerId,playerId,{
        operationType:'create', expectedRevision:0, operationKey:'f10:resume:ficha:create:0001',
        draft:{
            name:'Future Resume', age:19, gender:'Masculino', appearance:'Asta — Black Clover', rollNumber:1,
            familyKey:'sem_linhagem', magicKey:'magia_de_algodao', entitlementKeys:[], notes:null,
        },
    });
    await db.run(
        `UPDATE clover_prereset_characters SET status='locked', locked_at=CURRENT_TIMESTAMP WHERE player_id=? AND revision=?`,
        [playerId,created.character.revision]
    );
    await db.run(
        `INSERT INTO clover_prereset_launch_players
         (campaign_key,player_id,roster_revision,outcome,status,reset_operation_code)
         VALUES (?,?,1,'reset','applying',?)`,
        [DEFAULT_PRE_RESET_CAMPAIGN_KEY,playerId,resetCode]
    );

    const firstPlan = await assertFutureLaunchReady(db,playerId,DEFAULT_PRE_RESET_CAMPAIGN_KEY);
    assert.equal(firstPlan.mode,'promote');
    const firstReset = await resetForLaunch(db,{
        playerId, reason:resetReason, actorId:'admin-f10', operationCode:resetCode,
    });
    assert.equal(firstReset.ok,true);
    assert.equal(firstReset.duplicate,undefined);
    assert.equal((await db.get('SELECT personagem_nome FROM jogadores WHERE id=?',[playerId])).personagem_nome,'-');
    assert.equal((await db.get(
        `SELECT status FROM clover_prereset_future_slot_reservations
         WHERE campaign_key=? AND player_id=? AND roll_number=1 AND category='race'`,
        [DEFAULT_PRE_RESET_CAMPAIGN_KEY,playerId]
    )).status,'held');

    const promoted = await promoteFutureAfterReset(db,firstPlan,DEFAULT_PRE_RESET_CAMPAIGN_KEY);
    assert.equal(promoted.promoted,true);
    assert.equal(promoted.mode,'promote');
    assert.equal((await db.get('SELECT personagem_nome FROM jogadores WHERE id=?',[playerId])).personagem_nome,'Future Resume');
    assert.equal((await db.get(
        `SELECT status FROM clover_prereset_future_slot_reservations
         WHERE campaign_key=? AND player_id=? AND roll_number=1 AND category='race'`,
        [DEFAULT_PRE_RESET_CAMPAIGN_KEY,playerId]
    )).status,'consumed');

    const replayPlan = await assertFutureLaunchReady(db,playerId,DEFAULT_PRE_RESET_CAMPAIGN_KEY);
    assert.equal(replayPlan.mode,'already_promoted');
    const replayReset = await resetForLaunch(db,{
        playerId, reason:resetReason, actorId:'admin-f10', operationCode:resetCode,
    });
    assert.equal(replayReset.ok,true);
    assert.equal(replayReset.duplicate,true);
    assert.equal((await db.get('SELECT personagem_nome FROM jogadores WHERE id=?',[playerId])).personagem_nome,'Future Resume');
    const replayPromotion = await promoteFutureAfterReset(db,replayPlan,DEFAULT_PRE_RESET_CAMPAIGN_KEY);
    assert.equal(replayPromotion.duplicate,true);
    assert.equal((await db.get(
        `SELECT COUNT(*) AS total FROM clover_player_reset_events WHERE operation_code=?`,
        [resetCode]
    )).total,1);
    assert.equal((await db.get(
        `SELECT status FROM clover_prereset_future_slot_reservations
         WHERE campaign_key=? AND player_id=? AND roll_number=1 AND category='race'`,
        [DEFAULT_PRE_RESET_CAMPAIGN_KEY,playerId]
    )).status,'consumed');
});
