'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const sqlite3=require('sqlite3');
const {open}=require('sqlite');
const {ensureMissionParticipationSchema,joinMission,submitMission,getMyMission}=require('../helpers/clover/playerMissionLifecycleService');
const {listReviewCards,getReviewCard,decideReviewCard}=require('../helpers/clover/adminMissionReviewService');
const {renderReviewCard,renderReviewCards,renderReviewDecision}=require('../helpers/clover/adminMissionReviewMessages');
const actor={id:'fixture-reviewer',capabilities:['mission.manage']};
async function fixture(t){
    const db=await open({filename:':memory:',driver:sqlite3.Database});
    t.after(()=>db.close());
    await db.exec('PRAGMA foreign_keys=ON; CREATE TABLE jogadores(id TEXT PRIMARY KEY,personagem_nome TEXT,esquadrao TEXT,ficha_status TEXT DEFAULT \'aprovada\',jogo_status TEXT DEFAULT \'liberado\',historia_status TEXT DEFAULT \'pendente\');');
    await db.run('INSERT INTO jogadores(id,personagem_nome,esquadrao) VALUES (?,?,?)',['fixture-player@lid','Elian Vesper','Coringas Magenta']);
    await ensureMissionParticipationSchema(db);
    await db.run("INSERT INTO clover_missions(mission_key,status,revision,title,rank,mode,location,mission_type,risk,slots,deadline_at,reward_json,description,metadata_json) VALUES (?,'published',2,?,'D','auto_narrated','Capital','investigation','Baixo',4,?,?,?,'{}')",['ecos-fronteira','Ecos na Fronteira',new Date(Date.now()+86400000).toISOString(),JSON.stringify({ph:[0,0],yulls:[0,0],stars:[0,0]}),'Descubra a origem do fenômeno.']);
    const input={missionKey:'ecos-fronteira',playerId:'fixture-player@lid',text:'Eu investiguei todas as ruínas e retornei com evidências.'};
    await joinMission(db,input);
    await submitMission(db,input);
    return {db,input};
}
test('fila usa código persistente por revisão, não expõe JID, apresenta contrato e relato integral',async t=>{
    const {db,input}=await fixture(t);
    await assert.rejects(()=>listReviewCards(db,{id:'unauthorized',capabilities:[]}),e=>e.code==='missing_capability');
    const first=await listReviewCards(db,actor);
    assert.equal(first.total,1);
    const code=first.cards[0].code;
    assert.match(code,/^MR-[0-9A-F]{12}$/);
    assert.equal((await listReviewCards(db,actor)).cards[0].code,code);
    const list=renderReviewCards(first);
    assert.match(list,/Elian Vesper/);
    assert.doesNotMatch(list,/fixture-player@lid/);
    const detail=renderReviewCard(await getReviewCard(db,actor,code));
    assert.match(detail,/Descubra a origem do fenômeno/);
    assert.match(detail,new RegExp(input.text.replace('.','\\.')));
    assert.ok(detail.includes('\u031d'.repeat(1024)));
    assert.doesNotMatch(detail,/fixture-player@lid/);
    assert.match(detail,/aprovar/);
    await assert.rejects(()=>decideReviewCard(db,{id:input.playerId,capabilities:['mission.manage']},{code,decision:'approve'}),e=>e.code==='mission_self_review_forbidden');
    const returned=await decideReviewCard(db,actor,{code,decision:'return',reason:'Detalhe as evidências.'});
    assert.equal(returned.participation.status,'changes_requested');
    await submitMission(db,{...input,text:'Novo relato com testemunhas, provas e resultados documentados.'});
    const nextCode=(await listReviewCards(db,actor)).cards[0].code;
    assert.notEqual(nextCode,code);
    const old=renderReviewCard(await getReviewCard(db,actor,code));
    assert.match(old,/Esta versão não pode mais ser avaliada/);
    assert.ok(old.includes(nextCode));
    assert.doesNotMatch(old,/ aprovar/);
    await assert.rejects(()=>decideReviewCard(db,actor,{code,decision:'approve'}),e=>e.code==='mission_review_conflict');
    assert.equal((await getMyMission(db,input.missionKey,input.playerId)).status,'submitted');
    const approved=await decideReviewCard(db,actor,{code:nextCode,decision:'approve'});
    assert.equal(approved.participation.status,'approved');
    assert.match(renderReviewDecision(approved),/Recompensa-base registrada/);
    const duplicate=await decideReviewCard(db,actor,{code:nextCode,decision:'approve'});
    assert.equal(duplicate.duplicate,true);
    assert.match(renderReviewDecision(duplicate),/Nenhum valor adicional/);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_mission_payout_receipts')).n,1);
    assert.equal((await listReviewCards(db,actor)).total,0);
});
test('comando recusa grupos antes de consultar acesso e recusa ator sem permissão',async()=>{
    const Module=require('node:module');
    const file=require.resolve('../comandos/missaoReview');
    const original=Module._load;
    let checks=0;
    const replies=[];
    Module._load=function(request,parent,isMain){
        if(parent?.filename===file){
            if(request==='../helpers/chatReply')return {sendReply:async({text})=>replies.push(text)};
            if(request==='../helpers/clover/adminAccessService')return {getAdminActorAccess:async()=>{checks++;return {ok:true,actor:{id:'denied',capabilities:[]}}}};
        }
        return original.call(this,request,parent,isMain);
    };
    let command;
    try{delete require.cache[file];command=require(file);}finally{Module._load=original;delete require.cache[file];}
    await command.executar({idChat:'fixture-group@g.us',idJogador:'denied',db:{},body:'',matchedCommand:'.#avaliacoesmissoes'});
    assert.equal(checks,0);
    assert.match(replies.at(-1),/privado/);
    await command.executar({idChat:'fixture-adm@lid',idJogador:'denied',db:{},body:'',matchedCommand:'.#avaliacoesmissoes'});
    assert.equal(checks,1);
    assert.match(replies.at(-1),/não possui permissão/);
});
