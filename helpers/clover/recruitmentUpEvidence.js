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
module.exports={findEligibleFirstUp};
