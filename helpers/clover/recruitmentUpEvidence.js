'use strict';

// Only persisted, non-voided player evaluations count as first UP.
// A bookkeeping row created for the administrative PH cap is not a scene.
// Missing or invalid release/evaluation dates cannot prove eligibility.
async function findEligibleFirstUp(db,playerId,releasedAt=null,{evaluationId=null}={}){
    if(!releasedAt)return null;
    const date=await db.get('SELECT datetime(?) AS valid',[releasedAt]);
    if(!date?.valid)return null;
    const params=[playerId,releasedAt];
    let requested='';
    if(evaluationId!=null){requested='AND id=?';params.push(evaluationId);}
    return db.get(
        "SELECT * FROM clover_quick_evaluations WHERE player_id=? AND datetime(COALESCE(scene_sent_at,created_at))>=datetime(?) "+
        "AND COALESCE(modality_key,'')<>'admin_weekly_ph' "+
        "AND CASE WHEN metadata_json IS NULL OR metadata_json='' THEN 1 WHEN json_valid(metadata_json) THEN "+
        "COALESCE(json_extract(metadata_json,'$.administrative_weekly_ph'),0)<>1 AND COALESCE(json_extract(metadata_json,'$.hidden_from_evaluation_feed'),0)<>1 AND COALESCE(json_extract(metadata_json,'$.voided_by_correction'),0)<>1 ELSE 0 END "+
        "AND CASE WHEN rewards_json IS NULL OR rewards_json='' THEN 1 WHEN json_valid(rewards_json) THEN COALESCE(json_extract(rewards_json,'$.cap'),'')<>'anulado' ELSE 0 END "+
        requested+" ORDER BY datetime(COALESCE(scene_sent_at,created_at)) ASC,id ASC LIMIT 1",params
    );
}
async function findEligibleMission(db,playerId,releasedAt,{missionKey=null,submissionRevision=null}={}){
    if(!releasedAt)return null;
    const tables=await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('clover_mission_participations','clover_mission_payout_receipts','clover_mission_submission_history','clover_mission_review_history')");
    if(tables.length!==4)return null;
    const params=[playerId,releasedAt];
    let filter='';
    if(missionKey!==null){
        if(!Number.isSafeInteger(submissionRevision)||submissionRevision<1)return null;
        filter='AND p.mission_key=? AND p.submission_revision=?';
        params.push(missionKey,submissionRevision);
    }
    const rows=await db.all(
        "SELECT p.mission_key AS missionKey,p.player_id AS playerId,p.submission_revision AS submissionRevision,s.submitted_at AS activityAt,r.paid_at AS paidAt,p.snapshot_json,p.snapshot_hash,r.reward_json "+
        "FROM clover_mission_participations p "+
        "JOIN clover_mission_payout_receipts r ON r.mission_key=p.mission_key AND r.player_id=p.player_id AND r.snapshot_hash=p.snapshot_hash AND r.reviewed_by=p.reviewed_by "+
        "JOIN clover_mission_submission_history s ON s.mission_key=p.mission_key AND s.player_id=p.player_id AND s.submission_revision=p.submission_revision AND s.submission_text=p.submission_text AND s.submitted_at=p.submitted_at "+
        "JOIN clover_mission_review_history v ON v.mission_key=p.mission_key AND v.player_id=p.player_id AND v.submission_revision=p.submission_revision AND v.decision='approve' AND v.actor_id=p.reviewed_by "+
        "WHERE p.player_id=? AND p.status='approved' AND p.reviewed_by<>p.player_id AND datetime(s.submitted_at)>=datetime(?) AND datetime(r.paid_at)>=datetime(s.submitted_at) "+filter+
        " ORDER BY datetime(s.submitted_at),p.mission_key",params);
    const {fingerprint}=require('./adminMissionService');
    for(const row of rows){
        try{
            const snapshot=JSON.parse(row.snapshot_json),reward=JSON.parse(row.reward_json);
            if(fingerprint(snapshot)!==row.snapshot_hash || snapshot.missionKey!==row.missionKey || fingerprint(snapshot.reward)!==fingerprint(reward))continue;
            return {kind:'mission',missionKey:row.missionKey,playerId:row.playerId,submissionRevision:row.submissionRevision,activityAt:row.activityAt,paidAt:row.paidAt};
        }catch{ /* invalid evidence is not eligible */ }
    }
    return null;
}
async function findFirstRecruitmentActivity(db,playerId,releasedAt){
    const quick=await findEligibleFirstUp(db,playerId,releasedAt);
    const mission=await findEligibleMission(db,playerId,releasedAt);
    if(!quick)return mission;
    if(!mission)return quick;
    const cmp=await db.get('SELECT datetime(?) < datetime(?) AS earlier',[mission.activityAt,quick.scene_sent_at||quick.created_at]);
    return cmp?.earlier?mission:quick;
}
async function validateRecruitmentActivity(db,playerId,releasedAt,evidence){
    if(evidence?.kind==='mission')return findEligibleMission(db,playerId,releasedAt,{missionKey:evidence.missionKey,submissionRevision:evidence.submissionRevision});
    if(!Number.isSafeInteger(Number(evidence?.id))||Number(evidence.id)<1)return null;
    return findEligibleFirstUp(db,playerId,releasedAt,{evaluationId:evidence.id});
}
module.exports={findEligibleFirstUp,findEligibleMission,findFirstRecruitmentActivity,validateRecruitmentActivity};

