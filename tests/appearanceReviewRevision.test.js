'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {provisionSeasonLab}=require('../helpers/clover/seasonLabProvisioning');
const {criarBanco}=require('../database');
const {ensurePlayerRecord}=require('../helpers/playerRegistry');
function loadAppearanceForLab(){
    const Module=require('node:module');
    const target=require.resolve('../helpers/clover/appearanceManager');
    const original=Module._load;
    delete require.cache[target];
    Module._load=function(request,parent,isMain){
        if(parent?.filename===target){
            if(request==='../groupAccess')return {isOwner:()=>false,isSameUser:(a,b)=>a===b,getRegisteredOwner:()=>({})};
            if(request==='../chatReply')return {sendPrivateText:async()=>({ok:true})};
            if(request==='./archiveManager')return {syncArchiveCardForPlayer:async()=>({ok:true})};
            if(request==='./registrationManager')return {getCloverRegistrationGroup:async()=>null,preparePostFichaRelease:async()=>({ok:true}),maybeSendPostFichaPrivateInstructions:async()=>({ok:true})};
        }
        return original.call(this,request,parent,isMain);
    };
    try{return require(target);}finally{Module._load=original;delete require.cache[target];}
}
test('avaliação de aparência: revisão anterior, mesma aparência e entrega fora de ordem',async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clover-appearance-revision-'));
    let db;
    t.after(async()=>{try{if(db)await db.close();}finally{await fs.rm(dir,{recursive:true,force:true});}});
    const root=path.join(dir,'season');
    await provisionSeasonLab(root);
    db=await criarBanco({filename:path.join(root,'season.sqlite')});
    const api=loadAppearanceForLab();
    const playerId='fixture-player',idChat='fixture@g.us',reviewerId='fixture-admin';
    await ensurePlayerRecord(db,playerId,'Jogador fictício');
    const messages=[];
    let seq=0;
    const sock={groupMetadata:async()=>({participants:[{id:reviewerId,admin:'admin'}]}),
        sendMessage:async(id,message)=>{messages.push(message);return {key:{id:'message-'+(++seq)}};}};
    const current=()=>db.get('SELECT * FROM jogadores WHERE id=?',[playerId]);
    const notice=()=>api.sendAppearancePendingNotice({sock,db,playerId,groupId:idChat,scope:'reception'});
    const review=(messageId,reviewer=reviewerId)=>api.tryHandleAppearanceReviewReply({sock,db,idChat,reviewerId:reviewer,text:'ok',m:{message:{extendedTextMessage:{text:'ok',contextInfo:{stanzaId:messageId}}}}});
    await api.setAppearancePending(db,playerId,'Elian — Obra fictícia');
    const a=await notice();
    const revision1=(await current()).appearance_revision;
    await api.setAppearancePending(db,playerId,'Elian — Obra fictícia');
    assert.equal((await current()).appearance_revision,revision1+1);
    const b=await notice();
    assert.equal(await review(a.messageId),true);
    assert.equal((await current()).personagem_aparencia_status,'pending');
    assert.match(messages.at(-1).text,/revisão atual/);
    assert.equal(await review(b.messageId,'fixture-member'),false);
    assert.equal((await current()).personagem_aparencia_status,'pending');
    const originalSend=sock.sendMessage;
    sock.sendMessage=async(...args)=>{
        await api.setAppearancePending(db,playerId,'Elian — Obra fictícia');
        return originalSend(...args);
    };
    const delayed=await notice();
    sock.sendMessage=originalSend;
    assert.equal(await review(delayed.messageId),true);
    assert.equal((await current()).personagem_aparencia_status,'pending');
    await db.run("INSERT INTO clover_appearance_reviews(player_id,group_id,message_id,scope,appearance,appearance_normalized) VALUES(?,?,?,'reception',?,?)",[playerId,idChat,'legacy','Elian — Obra fictícia',(await current()).personagem_aparencia_normalizada]);
    assert.equal(await review('legacy'),true);
    assert.equal((await current()).personagem_aparencia_status,'pending');
    const fresh=await notice();
    assert.equal(await review(fresh.messageId),true);
    assert.equal((await current()).personagem_aparencia_status,'approved');
    assert.equal(await review(fresh.messageId),true);
    assert.equal((await current()).personagem_aparencia_status,'approved');
    assert.ok((await db.get('SELECT COUNT(*) AS n FROM clover_appearance_reviews')).n>=5);
});
