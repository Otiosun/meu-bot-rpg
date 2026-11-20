'use strict';
const { ensureMissionParticipationSchema, getMissionReviewDossier, reviewMission, MissionParticipationError } = require('./playerMissionLifecycleService');

function fail(code,message,status=409){throw new MissionParticipationError(code,message,status);}
function requireReviewAccess(actor) {
    if (!actor?.id || !actor.capabilities?.includes('mission.manage'))
        fail('missing_capability','Seu perfil não possui permissão para avaliar missões.',403);
}
async function playerLabel(db,id) {
    const row=await db.get('SELECT * FROM jogadores WHERE id=?',[id]);
    return {name:row?.personagem_nome && row.personagem_nome!=='-' ? row.personagem_nome : 'Personagem não identificado',
        squad:row?.esquadrao && row.esquadrao!=='-' ? row.esquadrao : null};
}
async function listReviewCards(db,actor,page=1) {
    requireReviewAccess(actor);
    if(!Number.isSafeInteger(page)||page<1||page>10000)fail('invalid_mission_page','Página inválida.',400);
    await ensureMissionParticipationSchema(db);
    const total=Number((await db.get("SELECT COUNT(*) AS n FROM clover_mission_participations WHERE status='submitted'")).n);
    const rows=await db.all("SELECT p.*, r.review_code FROM clover_mission_participations p LEFT JOIN clover_mission_review_refs r ON r.mission_key=p.mission_key AND r.player_id=p.player_id AND r.submission_revision=p.submission_revision WHERE p.status='submitted' ORDER BY p.submitted_at ASC,p.mission_key,p.player_id LIMIT 6 OFFSET ?",[(page-1)*6]);
    const cards=[];
    for(const row of rows){
        const dossier=await getMissionReviewDossier(db,row.mission_key,row.player_id,{staff:true});
        if(!dossier || dossier.participation.status!=='submitted' || dossier.participation.submissionRevision!==row.submission_revision)continue;
        cards.push({code:row.review_code||null,title:dossier.contract.title,rank:dossier.contract.rank,revision:row.submission_revision,...await playerLabel(db,row.player_id)});
    }
    return {total,page,pages:Math.max(1,Math.ceil(total/6)),cards};
}
async function getReviewCard(db,actor,code) {
    requireReviewAccess(actor);
    const ref=String(code||'').trim().toUpperCase();
    if(!/^MR-[0-9A-F]{12}$/.test(ref))fail('invalid_mission_review_code','Código de avaliação inválido.',400);
    await ensureMissionParticipationSchema(db);
    const row=await db.get('SELECT * FROM clover_mission_review_refs WHERE review_code=?',[ref]);
    if(!row)fail('mission_review_not_found','Avaliação não encontrada.',404);
    const dossier=await getMissionReviewDossier(db,row.mission_key,row.player_id,{staff:true});
    if(!dossier)fail('mission_review_not_found','Avaliação não encontrada.',404);
    const current=dossier.participation.submissionRevision===row.submission_revision;
    const active=current && dossier.participation.status==='submitted';
    const currentRef=current?null:await db.get('SELECT review_code FROM clover_mission_review_refs WHERE mission_key=? AND player_id=? AND submission_revision=?',[row.mission_key,row.player_id,dossier.participation.submissionRevision]);
    return {code:ref,revision:row.submission_revision,current,active,currentCode:currentRef?.review_code||null,
        ...await playerLabel(db,row.player_id),dossier};
}
async function decideReviewCard(db,actor,{code,decision,reason}) {
    requireReviewAccess(actor);
    const card=await getReviewCard(db,actor,code);
    if(!card.current)fail('mission_review_conflict','A entrega mudou. Abra o código da versão atual.');
    return reviewMission(db,{missionKey:card.dossier.participation.missionKey,playerId:card.dossier.participation.playerId,
        actorId:actor.id,decision,reason,expectedSubmissionRevision:card.revision});
}
module.exports={requireReviewAccess,listReviewCards,getReviewCard,decideReviewCard};
