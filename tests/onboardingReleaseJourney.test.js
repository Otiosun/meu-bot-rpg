'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {provisionSeasonLab}=require('../helpers/clover/seasonLabProvisioning');
const {criarBanco}=require('../database');
const {ensurePlayerRecord}=require('../helpers/playerRegistry');
const {getPlayerPhase,PHASES}=require('../helpers/clover/playerPhase');
const {INITIAL_PH_AMOUNT}=require('../helpers/clover/phService');

function loadForLab(deliver){
    const Module=require('node:module');
    const regPath=require.resolve('../helpers/clover/registrationManager');
    const appearancePath=require.resolve('../helpers/clover/appearanceManager');
    const original=Module._load;
    delete require.cache[regPath];delete require.cache[appearancePath];
    Module._load=function(request,parent,isMain){
        if([regPath,appearancePath].includes(parent?.filename)){
            if(request==='../chatReply')return {sendPrivateText:deliver};
            if(request==='../groupAccess')return {isOwner:()=>false,isSameUser:(a,b)=>a===b,getRegisteredOwner:()=>({})};
            if(request==='./groupManager')return {getOffGroupInviteLink:async()=>null};
            if(request==='./archiveManager')return {syncArchiveCardForPlayer:async()=>({ok:true})};
        }
        return original.call(this,request,parent,isMain);
    };
    try{return {reg:require(regPath),appearance:require(appearancePath)};}
    finally{Module._load=original;delete require.cache[regPath];delete require.cache[appearancePath];}
}

test('liberação real: rollback, aprovação sem rede, envio pulado e recuperação sem duplicar PH',async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clover-release-journey-'));
    let db;
    t.after(async()=>{try{if(db)await db.close();}finally{await fs.rm(dir,{recursive:true,force:true});}});
    const root=path.join(dir,'season');await provisionSeasonLab(root);
    db=await criarBanco({filename:path.join(root,'season.sqlite')});
    const playerId='release-fixture',admin='fixture-admin',group='fixture@g.us';
    let delivery='skip', sends=0;
    const {reg,appearance}=loadForLab(async({policy})=>{
        if(policy?.source==='post_ficha'){
            sends++;
            if(delivery==='skip')return {skipped:true,reason:'pv_policy_blocked'};
            return {key:{id:'fixture-private-receipt'}};
        }
        return {key:{id:'fixture-appearance-receipt'}};
    });
    const row=()=>db.get('SELECT * FROM jogadores WHERE id=?',[playerId]);
    const ledger=()=>db.all("SELECT * FROM clover_ph_ledger WHERE player_id=? AND source='initial_ph'",[playerId]);
    await ensurePlayerRecord(db,playerId,'Teste');
    await db.run("UPDATE jogadores SET ficha_status='aprovada',magia='Magia de Fogo',historia_status='pendente',jogo_status='bloqueado' WHERE id=?",[playerId]);
    await appearance.setAppearancePending(db,playerId,'Elian — Ficção');
    assert.equal((await reg.preparePostFichaRelease(db,playerId)).reason,'appearance_not_approved');
    assert.equal((await ledger()).length,0);
    let groupFails=false,sequence=0;
    const sock={groupMetadata:async()=>({participants:[{id:admin,admin:'admin'}]}),
        sendMessage:async()=>{if(groupFails)throw Error('fixture transport unavailable');return {key:{id:'fixture-'+(++sequence)}};}};
    const notice=await appearance.sendAppearancePendingNotice({sock,db,playerId,groupId:group,scope:'reception'});
    const review=()=>appearance.tryHandleAppearanceReviewReply({sock,db,idChat:group,reviewerId:admin,text:'ok',m:{message:{extendedTextMessage:{text:'ok',contextInfo:{stanzaId:notice.messageId}}}}});
    await db.exec("CREATE TEMP TRIGGER fail_release BEFORE UPDATE OF jogo_status ON jogadores WHEN NEW.jogo_status='liberado' BEGIN SELECT RAISE(ABORT,'fixture release rollback'); END");
    await assert.rejects(review,/fixture release rollback/);
    assert.equal((await row()).personagem_aparencia_status,'approved');
    assert.equal((await row()).jogo_status,'bloqueado');
    assert.equal((await ledger()).length,0);
    await db.exec('DROP TRIGGER fail_release');
    groupFails=true;
    // Retry approval of this revision repairs the incomplete release even
    // when its group acknowledgement cannot be sent.
    await assert.rejects(review,/fixture transport unavailable/);
    assert.equal((await row()).jogo_status,'liberado');
    assert.equal((await getPlayerPhase(db,playerId)).phase,PHASES.JOGO_LIBERADO);
    assert.equal((await row()).historia_pv_sent_at,null);
    assert.equal((await ledger()).length,1);
    assert.equal((await ledger())[0].amount,INITIAL_PH_AMOUNT);
    assert.equal((await db.get('SELECT current_step FROM player_onboarding WHERE player_id=?',[playerId])).current_step,'jogo_liberado');
    delivery='send';groupFails=false;
    assert.equal((await reg.maybeSendPostFichaPrivateInstructions(sock,db,playerId)).ok,true);
    assert.ok((await row()).historia_pv_sent_at);
    assert.equal((await reg.maybeSendPostFichaPrivateInstructions(sock,db,playerId)).reason,'already_sent');
    assert.equal(sends,2);
    assert.equal((await ledger()).length,1);
    // A later explicit administrative block must not be erased by retrying
    // old onboarding instructions.
    await db.run("UPDATE jogadores SET jogo_status='bloqueado',jogo_bloqueio_motivo='fixture admin block' WHERE id=?",[playerId]);
    assert.equal((await reg.preparePostFichaRelease(db,playerId)).reason,'explicit_game_block');
    assert.equal((await row()).jogo_status,'bloqueado');
});
