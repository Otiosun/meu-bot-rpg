'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const database = require('../database');
const { CURRENT_SCHEMA_MIGRATIONS } = require('../helpers/clover/schemaMigrationPlan');
const { createPreResetPolicyRegistry } = require('../helpers/clover/preResetPolicyRegistryService');
const { configurePrPvPolicy, convertLegacyPrToPv, replaceKeepRoster, finalizeRoster } = require('../helpers/clover/preResetLaunchService');
const { adminAdjustPr, getPrBalance } = require('../helpers/clover/prService');
const { creditPv, getPvBalance } = require('../helpers/clover/pvService');
const { buildSupplementManifest, settleSupplement, verifiedSupplementCarry } = require('../helpers/clover/prPvSupplementService');
const { buildPreResetLaunchPreviewReadOnly } = require('../scripts/previewPreResetLaunchReadOnly');
const CAMPAIGN = 'mythic_launch_v1';
function context() {
    return { actorId:'supplement-test-admin', env:{PRE_RESET:'OFF',PRE_RESET_LAUNCH_ENABLED:'true',PRE_RESET_RETURN_ENABLED:'true'},
        capabilities:['prereset.review','player.manage','operation.apply'],
        policyRegistry:createPreResetPolicyRegistry({testOnly:true,policies:{
            PRE_RESET_MODE:{status:'ENABLED',policyVersion:'supplement-test'},
            SESSION_ELIGIBILITY:{status:'ENABLED',policyVersion:'supplement-test',eligibleReleasedSessions:true},
        }}),
    };
}
async function fixture(t, version = 46) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'clover-supplement-test-'));
    const filename = path.join(dir,'copy.sqlite');
    let db = await database.criarBanco({filename,migrations:CURRENT_SCHEMA_MIGRATIONS.filter(m=>m.version<=version)});
    t.after(async()=>{await db.close();fs.rmSync(dir,{recursive:true,force:true});});
    return {get db(){return db;},async reopen(){await db.close();db=await database.criarBanco({filename});}};
}
async function setup(db,id='player',claim=true) {
    await db.run("INSERT INTO jogadores(id,nome,ficha_status,jogo_status,personagem_nome,personagem_aparencia,personagem_aparencia_status) VALUES(?,?,'aprovada','liberado',?,'fixture','approved')",[id,id,id]);
    const ctx=context();
    if (!await db.get("SELECT 1 FROM clover_prereset_pr_pv_policies WHERE status='approved'")) {
        await configurePrPvPolicy(db,ctx,{operationKey:'supplement:policy',policyVersion:'PRPV_1TO1_LRM_20260828_V1',numerator:1,denominator:1,rounding:'floor'});
    }
    if(claim){await adminAdjustPr(db,id,1,'historical fixture',ctx.actorId,{idempotencyKey:id+':historical'});await convertLegacyPrToPv(db,id,CAMPAIGN,ctx.actorId);}
    return ctx;
}
async function add(db,id,amount,key) {
    if(Number.isInteger(amount))return adminAdjustPr(db,id,amount,'authorized posterior fixture','supplement-test-admin',{idempotencyKey:key});
    // Historical group producer legitimately writes fractional REAL PR at 0.4/group.
    await db.run("INSERT INTO clover_pr_ledger(player_id,event_id,amount,kind,source,idempotency_key,reason,created_by,metadata_json) VALUES(?,1,?,'ganho','divulgacao_grupo',?,'group carry fixture','supplement-test-admin','{}')",[id,amount,key]);
}
async function request(db,id,key){return {operationKey:key,manifest:await buildSupplementManifest(db,id,CAMPAIGN)};}
async function claim(db,id){return db.get('SELECT * FROM clover_prereset_pr_pv_claims WHERE player_id=?',[id]);}

test('supplement: multiple posterior credits, immutable claim, retry and preview gate',async t=>{
    const {db}=await fixture(t);const ctx=await setup(db);const original=await claim(db,'player');
    await add(db,'player',100,'posterior:bonus');await add(db,'player',382,'posterior:conversion');
    await replaceKeepRoster(db,ctx,{operationKey:'supplement:roster',expectedRevision:0,keepPlayerIds:['player']});
    await finalizeRoster(db,ctx,{operationKey:'supplement:finalize',expectedRevision:1});
    assert.equal((await buildPreResetLaunchPreviewReadOnly(db)).allReviewable,false);
    const req=await request(db,'player','supplement:normal');
    assert.equal(req.manifest.posteriorIds.length,2);
    assert.deepEqual(await settleSupplement(db,ctx,req),{ok:true,duplicate:false,creditedPv:482,carryUnits:0});
    assert.equal(await getPvBalance(db,'player'),483);assert.equal(await getPrBalance(db,'player'),0);
    assert.deepEqual(await claim(db,'player'),original);
    assert.equal((await buildPreResetLaunchPreviewReadOnly(db)).allReviewable,true);
    assert.equal((await settleSupplement(db,ctx,req)).duplicate,true);
    assert.equal((await convertLegacyPrToPv(db,'player',CAMPAIGN,ctx.actorId)).duplicate,true);
    assert.equal(await getPvBalance(db,'player'),483);
    await assert.rejects(settleSupplement(db,ctx,{...req,manifest:{...req.manifest,sourceUnits:1}}),{code:'supplement_idempotency_conflict'});
    await assert.rejects(db.run("UPDATE clover_pr_pv_supplements SET carry_units=1"),/pr_pv_supplement_immutable/);
});

test('supplement: failure after PV insert rolls back both ledgers and audit',async t=>{
    const {db}=await fixture(t);const ctx=await setup(db);await add(db,'player',100,'rollback:posterior');
    const original=await claim(db,'player'),req=await request(db,'player','supplement:rollback');
    await db.exec("CREATE TEMP TRIGGER reject_supplement_pr BEFORE INSERT ON clover_pr_ledger WHEN NEW.idempotency_key='supplement:rollback:pr' BEGIN SELECT RAISE(ABORT,'injected_rollback'); END;");
    await assert.rejects(settleSupplement(db,ctx,req),/injected_rollback/);
    assert.equal(await getPvBalance(db,'player'),1);assert.equal(await getPrBalance(db,'player'),100);
    assert.equal((await db.get('SELECT COUNT(*) n FROM clover_pr_pv_supplements')).n,0);
    assert.deepEqual(await claim(db,'player'),original);
    await db.exec('DROP TRIGGER reject_supplement_pr');
    assert.equal((await settleSupplement(db,ctx,req)).creditedPv,100);
});

test('supplement: Osborn and Roque retain exact fractional rights and launch conversion does not consume carry',async t=>{
    const {db}=await fixture(t);const ctx=await setup(db,'Osborn',false);await setup(db,'Roque',true);
    await add(db,'Osborn',30,'osborn:historical-earned');await add(db,'Osborn',-30,'osborn:historical-spent');
    await db.run(`INSERT INTO clover_pr_ledger(player_id,event_id,amount,kind,source,idempotency_key,reason,created_by,metadata_json) VALUES('Roque',1,?,'ajuste_admin','ajuste_admin','clover:prereset:pr-dust-final:20260828:fixture','historical IEEE-754 cleanup','historical-admin',?)`,[-1.1102230246251565e-16,JSON.stringify({cleanup_kind:'legacy_pr_ieee754_dust',phase:'post_conversion_exact_zero',campaign_key:CAMPAIGN,policy_version:'PRPV_1TO1_LRM_20260828_V1',approval_id:'owner-prpv-20260828-1502',observed_balance:1.1102230246251565e-16,applied_delta:-1.1102230246251565e-16})]);
    await add(db,'Osborn',1356.4,'osborn:posterior');await add(db,'Roque',1840.2,'roque:posterior');
    const roqueClaim=await claim(db,'Roque');
    await assert.rejects(creditPv(db,'Osborn',0.4,{operationKey:'fraction:pv',source:'fixture',reason:'fixture',createdBy:ctx.actorId}),{code:'invalid_amount'});
    await replaceKeepRoster(db,ctx,{operationKey:'fraction:roster',expectedRevision:0,keepPlayerIds:['Osborn','Roque']});
    await finalizeRoster(db,ctx,{operationKey:'fraction:finalize',expectedRevision:1});
    assert.equal((await buildPreResetLaunchPreviewReadOnly(db)).allReviewable,false);
    for(const [id,pv,carry] of [['Osborn',1356,40],['Roque',1840,20]]) {
        const req=await request(db,id,'supplement:'+id);
        assert.equal((await settleSupplement(db,ctx,req)).carryUnits,carry);
        assert.equal(Math.round((await getPrBalance(db,id))*100),carry);
        assert.equal(await getPvBalance(db,id),pv+(id==='Roque'?1:0));
        assert.equal((await verifiedSupplementCarry(db,id,CAMPAIGN)).carryUnits,carry);
        assert.equal((await convertLegacyPrToPv(db,id,CAMPAIGN,ctx.actorId)).supplement.carryUnits,carry);
        assert.equal((await settleSupplement(db,ctx,req)).duplicate,true);
    }
    assert.equal(await claim(db,'Osborn'),undefined);assert.deepEqual(await claim(db,'Roque'),roqueClaim);
    assert.equal((await buildPreResetLaunchPreviewReadOnly(db)).allReviewable,true);
});

test('supplement: fresh credit invalidates preview and stale manifest; subsequent carry settlement is exact',async t=>{
    const {db}=await fixture(t);const ctx=await setup(db,'carry',false);
    await add(db,'carry',0.4,'carry:first');const first=await request(db,'carry','supplement:carry:first');
    await settleSupplement(db,ctx,first);
    await replaceKeepRoster(db,ctx,{operationKey:'carry:roster',expectedRevision:0,keepPlayerIds:['carry']});
    await finalizeRoster(db,ctx,{operationKey:'carry:finalize',expectedRevision:1});
    assert.equal((await buildPreResetLaunchPreviewReadOnly(db)).allReviewable,true);
    const stale=await request(db,'carry','supplement:carry:stale');
    await add(db,'carry',0.6,'carry:second');
    await assert.rejects(settleSupplement(db,ctx,stale),{code:'supplement_manifest_changed'});
    assert.equal((await buildPreResetLaunchPreviewReadOnly(db)).allReviewable,false);
    await assert.rejects(convertLegacyPrToPv(db,'carry',CAMPAIGN,ctx.actorId),{code:'supplement_source_changed'});
    assert.equal((await settleSupplement(db,ctx,await request(db,'carry','supplement:carry:second'))).creditedPv,1);
    assert.equal(await getPvBalance(db,'carry'),1);assert.equal(await getPrBalance(db,'carry'),0);
    assert.equal((await buildPreResetLaunchPreviewReadOnly(db)).allReviewable,true);
});

test('supplement: refund is not silently treated as an authorized positive delta',async t=>{
    const {db}=await fixture(t);await setup(db);await add(db,'player',100,'refund:credit');await add(db,'player',-1,'refund:debit');
    await assert.rejects(buildSupplementManifest(db,'player',CAMPAIGN),{code:'supplement_not_positive_posterior_credit'});
});

test('supplement: an orphan ledger key cannot be reused to credit or debit twice',async t=>{
    const {db}=await fixture(t);const ctx=await setup(db);await add(db,'player',100,'orphan:posterior');
    await creditPv(db,'player',100,{entryKind:'migration',operationKey:'supplement:orphan:pv',source:'pr_pv_supplement',reason:'orphan fixture',createdBy:ctx.actorId});
    await assert.rejects(settleSupplement(db,ctx,await request(db,'player','supplement:orphan')),{code:'supplement_ledger_key_conflict'});
    assert.equal(await getPrBalance(db,'player'),100);assert.equal(await getPvBalance(db,'player'),101);
    assert.equal((await db.get('SELECT COUNT(*) n FROM clover_pr_pv_supplements')).n,0);
});

test('supplement: historical schema 45 upgrades to 46 and reopening is idempotent',async t=>{
    const f=await fixture(t,45);await setup(f.db);
    const before=await f.db.all('SELECT * FROM clover_schema_migrations ORDER BY version');
    await f.reopen();
    const after=await f.db.all('SELECT * FROM clover_schema_migrations ORDER BY version');
    assert.deepEqual(after.slice(0,45),before);assert.equal(after.at(-1).version,46);
    await f.reopen();assert.deepEqual(await f.db.all('SELECT * FROM clover_schema_migrations ORDER BY version'),after);
    assert.equal(Object.values(await f.db.get('PRAGMA quick_check'))[0],'ok');
    assert.deepEqual(await f.db.all('PRAGMA foreign_key_check'),[]);
});
