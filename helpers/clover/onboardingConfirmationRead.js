'use strict';

// One policy for action handlers and read-only onboarding navigation.
const PROFILE_CONFIRMATION_TTL_DAYS=7;
const MAGIC_CONFIRMATION_TTL_HOURS=1;
const PROFILE_EXPIRY='-'+PROFILE_CONFIRMATION_TTL_DAYS+' days';
const MAGIC_EXPIRY='-'+MAGIC_CONFIRMATION_TTL_HOURS+' hours';

async function readPendingProfile(db,playerId){
    const row=await db.get("SELECT payload FROM pending_profile_confirmations WHERE player_id=? AND datetime(created_at)>=datetime('now',?)",[playerId,PROFILE_EXPIRY]);
    if(!row)return null;
    try{
        const value=JSON.parse(row.payload);
        return value && typeof value==='object' && !Array.isArray(value)?value:null;
    }catch{return null;}
}
async function readPendingMagic(db,playerId){
    return (await db.get("SELECT player_id,magic_label,roll_number,created_at FROM pending_magic_confirmations WHERE player_id=? AND datetime(created_at)>=datetime('now',?)",[playerId,MAGIC_EXPIRY]))||null;
}
module.exports={PROFILE_CONFIRMATION_TTL_DAYS,MAGIC_CONFIRMATION_TTL_HOURS,PROFILE_EXPIRY,MAGIC_EXPIRY,readPendingProfile,readPendingMagic};
