'use strict';
const { DEFAULT_PRE_RESET_CAMPAIGN_KEY } = require('./preResetCampaignStateService');
async function getResetDeferredState(db, playerId) {
    try {
        return await db.get(`SELECT p.status,p.last_error_code,r.status roster_status
            FROM clover_prereset_launch_players p JOIN clover_prereset_launch_rosters r USING(campaign_key)
            WHERE p.campaign_key=? AND p.player_id=? AND p.outcome='reset'
            AND p.status<>'completed' AND p.last_error_code='reset_deferred'`,[DEFAULT_PRE_RESET_CAMPAIGN_KEY,String(playerId)]) || null;
    } catch (error) {
        if (/no such table: clover_prereset_launch_(players|rosters)/i.test(error.message)) return null;
        throw error;
    }
}
async function assertResetPlayerCanPlay(db, playerId) {
    if (await getResetDeferredState(db,playerId)) throw Object.assign(new Error('Ficha futura pendente; reset individual ainda nao concluido.'),{code:'future_character_pending'});
}
module.exports={getResetDeferredState,assertResetPlayerCanPlay};
