'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {provisionSeasonLab}=require('../helpers/clover/seasonLabProvisioning');
const {criarBanco}=require('../database');
const {ensurePlayerRecord}=require('../helpers/playerRegistry');
const {ensureRecruitmentCode,submitReferralCode,tryValidateReferralFromEvaluation,deliverReferralRewards}=require('../helpers/clover/recruitmentService');
const {getEvent,getPrSummary}=require('../helpers/clover/prService');
const {getPhSummary}=require('../helpers/clover/phService');
const {getYullsSummary}=require('../helpers/clover/yullsService');
const {recordWeeklyPhUsageInTransaction,resolveEffectiveDate}=require('../helpers/clover/weeklyPhCapService');

test('recrutamento real: primeiro UP legítimo paga PR, PH, Yulls e item uma única vez',async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clover-recruitment-journey-'));
    let db;
    t.after(async()=>{try{if(db)await db.close();}finally{await fs.rm(dir,{recursive:true,force:true});}});
    const root=path.join(dir,'season');await provisionSeasonLab(root);
    const filename=path.join(root,'season.sqlite');
    db=await criarBanco({filename});
    const recruit='lab-recruit',sponsor='lab-sponsor',reviewer='lab-reviewer';
    const releaseAt=new Date(Date.now()-86400000).toISOString().replace('T',' ').slice(0,19);
    for(const id of [recruit,sponsor]){
        await ensurePlayerRecord(db,id,'Personagem fictício');
        await db.run("UPDATE jogadores SET personagem_nome=?,ficha_status='aprovada',magia='Magia de Fogo',personagem_aparencia_status='approved',jogo_status='liberado',jogo_liberado_at=? WHERE id=?",[id,releaseAt,id]);
    }
    const code=await ensureRecruitmentCode(db,sponsor);
    const pr=(await getPrSummary(db,sponsor)).recruitmentBalance;
    const ph=(await getPhSummary(db,recruit)).phAvailable;
    const yulls=(await getYullsSummary(db,recruit)).balance;
    const countItems=()=>db.get("SELECT COUNT(*) AS n FROM clover_inventory_items WHERE player_id=? AND source='recrutamento'",[recruit]);
    const itemsBefore=(await countItems()).n;
    // The same bookkeeping writer used by admin weekly grants, not a fabricated
    // test-only modality. It creates a hidden quick-evaluation entry.
    const week=resolveEffectiveDate(new Date());
    await db.exec('BEGIN IMMEDIATE');
    try{
        await recordWeeklyPhUsageInTransaction(db,{usageKey:'fixture-admin-ph',playerId:recruit,weekKey:week.weekKey,effectiveDate:week.localDate,requestedAmount:5,appliedAmount:5,createdBy:reviewer});
        await db.exec('COMMIT');
    }catch(e){await db.exec('ROLLBACK');throw e;}
    const bookkeeping=await db.get("SELECT * FROM clover_quick_evaluations WHERE player_id=? AND modality_key='admin_weekly_ph'",[recruit]);
    const started=await submitReferralCode(db,recruit,code);
    assert.equal(started.validation.validated,false);
    assert.equal((await tryValidateReferralFromEvaluation(db,{playerId:recruit,evaluationId:bookkeeping.id})).validated,false);
    const event=await getEvent(db);
    assert.equal((await db.get('SELECT status FROM clover_recruitment_referrals WHERE id=?',[started.referral.id])).status,'pending');
    await assert.rejects(()=>deliverReferralRewards(db,started.referral,bookkeeping),e=>e.code==='invalid_first_up_evidence');
    assert.equal((await getPrSummary(db,sponsor)).recruitmentBalance,pr);
    assert.equal((await getPhSummary(db,recruit)).phAvailable,ph);
    assert.equal((await countItems()).n,itemsBefore);
    // Seed a persisted genuine evaluation as boundary input; evaluating the
    // scene itself is covered by the separate quick-evaluation test suite.
    const ins=await db.run("INSERT INTO clover_quick_evaluations(message_key,quoted_message_key,chat_id,player_id,evaluator_id,modality_key,modality_label,ph_amount,yulls_amount,stars_amount,scene_sent_at,scene_source,evaluated_at,week_key,bypass_weekly_limit,rewards_json,metadata_json) VALUES('fixture-real-up',NULL,'fixture-group',?,?,'treino_solo','Treino Solo',5,0,0,CURRENT_TIMESTAMP,'evaluation_fallback',CURRENT_TIMESTAMP,?,0,'{}','{}')",[recruit,reviewer,week.weekKey]);
    const result=await tryValidateReferralFromEvaluation(db,{playerId:recruit,evaluationId:ins.lastID,actorId:reviewer});
    assert.equal(result.validated,true);
    assert.equal(result.referral.status,'rewarded');
    assert.equal(result.referral.validation_evaluation_id,ins.lastID);
    assert.equal((await getPrSummary(db,sponsor)).recruitmentBalance,pr+Number(event.recruiter_pr_reward));
    assert.equal((await getPhSummary(db,recruit)).phAvailable,ph+Number(event.recruit_ph_reward));
    assert.equal((await getYullsSummary(db,recruit)).balance,yulls+Number(event.recruit_yulls_reward));
    assert.equal((await countItems()).n,itemsBefore+(event.recruit_item_reward&&Number(event.recruit_item_quantity)>0?Number(event.recruit_item_quantity):0));
    await db.close();db=null;db=await criarBanco({filename});
    const replay=await deliverReferralRewards(db,started.referral,{id:ins.lastID},reviewer);
    assert.equal(replay.duplicate,true);
    assert.equal((await getPrSummary(db,sponsor)).recruitmentBalance,pr+Number(event.recruiter_pr_reward));
    assert.equal((await getPhSummary(db,recruit)).phAvailable,ph+Number(event.recruit_ph_reward));
    assert.equal((await getYullsSummary(db,recruit)).balance,yulls+Number(event.recruit_yulls_reward));
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM clover_recruitment_reward_deliveries WHERE referral_id=? AND status='completed'",[started.referral.id])).n,1);
    assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]);
});
