'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {provisionSeasonLab}=require('../helpers/clover/seasonLabProvisioning');
const {criarBanco}=require('../database');
const {ensurePlayerRecord,getOnboardingState}=require('../helpers/playerRegistry');
const {createAndStoreRoll,listPlayerRolls,rollbackStoredRoll}=require('../helpers/rollManager');
const {loadCloverConfigs}=require('../helpers/clover/configLoader');
const {getAvailableMagicsForRoll}=require('../helpers/magicManager');
const {analyzeProfileSubmission,savePendingConfirmation,confirmPendingProfile}=require('../helpers/profileForms');
const {getPlayerPhase,PHASES,canUseCommandInPhase}=require('../helpers/clover/playerPhase');
const {reserveSlot}=require('../helpers/clover/slotManager');
const {createMissionExecutors}=require('../helpers/clover/adminMissionService');
const {joinMission,getMyMission,ensureMissionParticipationSchema}=require('../helpers/clover/playerMissionLifecycleService');
const {listReviewCards,decideReviewCard}=require('../helpers/clover/adminMissionReviewService');
const {getPhSummary,INITIAL_PH_AMOUNT}=require('../helpers/clover/phService');
const {getYullsSummary}=require('../helpers/clover/yullsService');
const {getServiceSummary}=require('../helpers/clover/adminService');
const {getCharacterStats}=require('../helpers/clover/characterStats');


// Use production command handlers and gameplay services, mock only the
// external messaging/identity/archive boundaries. No WhatsApp connection.
function loadJourneyHandlers(replies){
    const Module=require('node:module');
    const paths=['../helpers/clover/registrationManager','../helpers/clover/appearanceManager','../comandos/atributos','../comandos/continuar','../comandos/missao','../comandos/missoes','../comandos/minhasmissoes'];
    const targets=paths.map(p=>require.resolve(p));
    const original=Module._load;
    for(const p of targets)delete require.cache[p];
    const transport={sendReply:async({text})=>{replies.push(text);return {key:{id:'fixture-reply-'+replies.length}};},
        sendPrivateText:async({text})=>{replies.push(text);return {key:{id:'fixture-private-'+replies.length}};}};
    Module._load=function(request,parent,isMain){
        if(targets.includes(parent?.filename)){
            if(request==='../chatReply'||request==='../helpers/chatReply')return transport;
            if(request==='../groupAccess'||request==='../helpers/groupAccess')return {isOwner:()=>false,isSameUser:(a,b)=>a===b,getRegisteredOwner:()=>({})};
            if(request==='./groupManager')return {getOffGroupInviteLink:async()=>null};
            if(request==='./archiveManager')return {syncArchiveCardForPlayer:async()=>({ok:true})};
        }
        return original.call(this,request,parent,isMain);
    };
    try{
        const [registration,appearance,attributes,continuar,mission,board,mine]=targets.map(p=>require(p));
        return {registration,appearance,attributes,continuar,mission,board,mine};
    }finally{Module._load=original;for(const p of targets)delete require.cache[p];}
}

test('jornada em banco novo: recepção, quatro rolls, ficha, liberação, atributos, missão e recompensa',async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clover-profile-journey-'));
    const root=path.join(dir,'season');
    await provisionSeasonLab(root);
    const filename=path.join(root,'season.sqlite');
    let db=await criarBanco({filename});
    t.after(async()=>{try{if(db)await db.close();}finally{await fs.rm(dir,{recursive:true,force:true});}});
    const playerId='fictional-journey-player';
    const phase=async()=> (await getPlayerPhase(db,playerId)).phase;
    assert.equal(await phase(),PHASES.NOVO);
    await ensurePlayerRecord(db,playerId,'Jogador de laboratório');
    await getOnboardingState(db,playerId);
    assert.equal(await phase(),PHASES.PRE_ROLL);
    // Use the real engine with deterministic entropy only within this fixture.
    const originalRandom=Math.random;
    try{
        Math.random=()=>0;
        let first=await createAndStoreRoll(db,playerId);
        assert.equal(first.ok,true);
        await rollbackStoredRoll(db,playerId,first.roll.rollNumber);
        assert.equal((await listPlayerRolls(db,playerId)).length,0);
        for(let i=1;i<=4;i++){
            const result=await createAndStoreRoll(db,playerId);
            assert.equal(result.ok,true);
            assert.equal(result.roll.rollNumber,i);
            assert.equal(await phase(),i===4?PHASES.ROLLS_CONCLUIDOS:PHASES.ROLLS_EM_ANDAMENTO);
        }
    }finally{Math.random=originalRandom;}
    assert.equal((await createAndStoreRoll(db,playerId)).reason,'limit_reached');
    const roll=(await listPlayerRolls(db,playerId))[0];
    const configs=loadCloverConfigs();
    const magic=getAvailableMagicsForRoll(roll).find(x=>!x.capacity);
    assert.ok(magic,'must have a compatible unlimited magic');
    // An existing real hold from an unselected roll must survive rollback,
    // then be released by the successful confirmation of the selected roll.
    const otherRace=configs.lists.races.find(x=>x.capacity&&x.key!==roll.race_key);
    assert.ok(otherRace);
    const hold=await reserveSlot(db,playerId,'race',otherRace.key,'roll_race',2);
    assert.equal(hold.ok,true);
    const body=[
        '     -- dados do jogador --',
        'Nome: Jogador de laboratório','Idade pessoal: 21',
        'O que gosta de fazer: Leitura','Disponibilidade detalhada: Finais de semana',
        '     -- dados do personagem --','Nome: Elian Vesper','Idade do personagem: 19',
        'Aparência: Personagem fictício - Obra fictícia','Gênero: Masculino',
        'Número do Roll: 1','Família: Nenhuma','Magia: '+magic.label,
        'Aptidão: '+configs.lists.commonAptitudes[0].name,'Marca: '+configs.lists.commonMarks[0].name,
        'Anomalia: Nenhuma'
    ].join('\n');
    const invalid=await analyzeProfileSubmission(db,playerId,body.replace('Número do Roll: 1','Número do Roll: 99'));
    assert.equal(invalid.ok,false);
    const analysis=await analyzeProfileSubmission(db,playerId,body);
    assert.equal(analysis.ok,true,JSON.stringify(analysis.errors));
    await savePendingConfirmation(db,playerId,analysis.payload);
    assert.equal(await phase(),PHASES.FICHA_PENDENTE_CONFIRMACAO);
    const snapshot=async()=>({
        player:await db.get('SELECT * FROM jogadores WHERE id=?',[playerId]),
        reservations:await db.all('SELECT * FROM slot_reservations WHERE player_id=? ORDER BY id',[playerId]),
        pending:await db.get('SELECT * FROM pending_profile_confirmations WHERE player_id=?',[playerId])
    });
    const before=await snapshot();
    await db.exec("CREATE TEMP TRIGGER fail_profile_delete BEFORE DELETE ON pending_profile_confirmations WHEN OLD.player_id='fictional-journey-player' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
    await assert.rejects(()=>confirmPendingProfile(db,playerId),/fixture rollback/);
    assert.deepEqual(await snapshot(),before);
    assert.equal(await phase(),PHASES.FICHA_PENDENTE_CONFIRMACAO);
    await db.exec('DROP TRIGGER fail_profile_delete');
    const result=await confirmPendingProfile(db,playerId);
    assert.equal(result.ok,true,JSON.stringify(result.errors));
    assert.equal(result.player.personagem_nome,'Elian Vesper');
    assert.equal(result.player.magia,magic.label);
    assert.equal((await db.get('SELECT status FROM slot_reservations WHERE id=?',[hold.reservation.id])).status,'released');
    assert.equal(await phase(),PHASES.APARENCIA_PENDENTE);
    assert.equal(canUseCommandInPhase('.#missao',await phase()),false);
    assert.equal((await confirmPendingProfile(db,playerId)).reason,'missing_pending');
    assert.equal((await listPlayerRolls(db,playerId)).length,4);
    await db.close();db=null;
    db=await criarBanco({filename});
    assert.equal(await phase(),PHASES.APARENCIA_PENDENTE);
    assert.equal((await db.get('SELECT magia FROM jogadores WHERE id=?',[playerId])).magia,magic.label);
    assert.equal((await listPlayerRolls(db,playerId)).length,4);
    assert.equal((await confirmPendingProfile(db,playerId)).reason,'missing_pending');

    const replies=[];
    const handlers=loadJourneyHandlers(replies);
    const actor={id:'fixture-adm',capabilities:['mission.manage']};
    const missionKey='primeira-patrulha-laboratorio';
    const missionInput={missionKey,playerId};
    const execs=createMissionExecutors();
    const context=(action,more={})=>({db,operation:{actor,reason:'fixture de jornada'},action,target:{kind:'system',systemKey:'clover'},...more});
    const create={type:'system.mission.create',payload:{
        missionKey,title:'Vigília na Fronteira',rank:'D',mode:'auto_narrated',
        location:'Fronteira de Clover',missionType:'investigation',risk:'Baixo',slots:2,
        deadlineAt:new Date(Date.now()+86400000).toISOString(),
        reward:{ph:[10,10],yulls:[900,900],stars:[1,1]},
        description:'Investigue os registros da fronteira e retorne com evidências.',countsForSalary:true
    }};
    const draft=await execs[create.type].preview(context(create));
    await execs[create.type].apply(context(create,{after:draft.after}));
    const publish={type:'system.mission.status.transition',payload:{missionKey,status:'published'}};
    const p=await execs[publish.type].preview(context(publish));
    await execs[publish.type].apply(context(publish,{before:p.before,after:p.after}));
    let seq=0;
    const group='fixture@g.us';
    const sock={groupMetadata:async()=>({participants:[{id:actor.id,admin:'admin'}]}),
        sendMessage:async(_chat,payload)=>{replies.push(payload.text||payload.caption);return {key:{id:'fixture-notice-'+(++seq)}};}};
    const run=async(command,body='',matchedCommand=command.nome)=>{
        await command.executar({db,sock,m:{key:{id:'fixture-command'}},idJogador:playerId,idChat:group,body,matchedCommand});
        return replies.at(-1);
    };
    await assert.rejects(()=>joinMission(db,missionInput),e=>e.code==='game_not_released');
    await ensureMissionParticipationSchema(db);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_mission_participations')).n,0);
    assert.equal(await phase(),PHASES.APARENCIA_PENDENTE);
    const notice=await handlers.appearance.sendAppearancePendingNotice({sock,db,playerId,groupId:group,scope:'reception'});
    assert.ok(notice.ok);
    assert.equal(await handlers.appearance.tryHandleAppearanceReviewReply({
        sock,db,idChat:group,reviewerId:actor.id,text:'ok',
        m:{message:{extendedTextMessage:{text:'ok',contextInfo:{stanzaId:notice.messageId}}}}
    }),true);
    assert.equal(await phase(),PHASES.JOGO_LIBERADO);
    assert.equal((await getPhSummary(db,playerId)).phAvailable,INITIAL_PH_AMOUNT);
    assert.match(await run(handlers.continuar),/confirmaratributos/);
    await run(handlers.attributes,'distribuir forca 1 velocidade 1 agilidade 1 resistencia 1 pm 1');
    assert.equal((await getCharacterStats(db,playerId)).distribution_status,'pending_confirmation');
    await run(handlers.attributes,'','.#confirmaratributos');
    assert.equal((await getCharacterStats(db,playerId)).distribution_status,'confirmed');
    assert.match(await run(handlers.continuar),/Escolha uma missão no mural/);
    assert.match(await run(handlers.board),/Vigília na Fronteira/);
    const phBefore=(await getPhSummary(db,playerId)).phAvailable;
    const yullsBefore=(await getYullsSummary(db,playerId)).balance;
    const starsBefore=Number((await db.get('SELECT estrelas FROM jogadores WHERE id=?',[playerId])).estrelas||0);
    await run(handlers.mission,missionKey+' aceitar');
    assert.equal((await getMyMission(db,missionKey,playerId)).status,'in_progress');
    assert.match(await run(handlers.continuar),/Continue sua missão/);
    await run(handlers.mission,missionKey+' entregar | Examinei a fronteira, encontrei os registros e retornei com as evidências.');
    assert.equal((await getMyMission(db,missionKey,playerId)).status,'submitted');
    assert.match(await run(handlers.continuar),/aguarda avaliação/);
    const card=(await listReviewCards(db,actor)).cards[0];
    await decideReviewCard(db,actor,{code:card.code,decision:'return',reason:'Informe a origem dos registros.'});
    assert.match(await run(handlers.continuar),/Ajustes solicitados/);
    await run(handlers.mission,missionKey+' entregar | Identifiquei a origem dos registros e apresentei provas e testemunhas da fronteira.');
    const revised=(await listReviewCards(db,actor)).cards[0];
    const approved=await decideReviewCard(db,actor,{code:revised.code,decision:'approve'});
    assert.equal(approved.participation.status,'approved');
    assert.equal((await getPhSummary(db,playerId)).phAvailable,phBefore+10);
    assert.equal((await getYullsSummary(db,playerId)).balance,yullsBefore+900);
    assert.equal((await db.get('SELECT estrelas FROM jogadores WHERE id=?',[playerId])).estrelas,starsBefore+1);
    assert.equal((await getServiceSummary(db,actor.id)).pendingPoints,2);
    assert.match(await run(handlers.mine),/Vigília na Fronteira/);
    assert.match(await run(handlers.continuar),/Escolha uma missão no mural/);
    await db.close();db=null;db=await criarBanco({filename});
    assert.equal(await phase(),PHASES.JOGO_LIBERADO);
    assert.equal((await decideReviewCard(db,actor,{code:revised.code,decision:'approve'})).duplicate,true);
    assert.equal((await getPhSummary(db,playerId)).phAvailable,phBefore+10);
    assert.equal((await getYullsSummary(db,playerId)).balance,yullsBefore+900);
    assert.equal((await getServiceSummary(db,actor.id)).pendingPoints,2);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_mission_payout_receipts')).n,1);
    assert.equal(Object.values(await db.get('PRAGMA integrity_check'))[0],'ok');
    assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]);
});
