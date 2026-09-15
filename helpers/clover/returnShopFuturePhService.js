'use strict';

// The caller owns the transaction that credits PH and consumes its entitlement.
// No current-world initialization or initial PH grant belongs in this provider.
async function creditFuturePhInTransaction(db, playerId, row, item, {campaignKey,actorId}) {
    const snapshot=JSON.parse(row.metadata_json);
    const quantity=Number(snapshot.quantity);
    if(item.effectKind!=='future_ph' || item.effectValue!==null
        || snapshot.effectKind!=='future_ph' || snapshot.effectValue!==null
        || !Number.isSafeInteger(quantity) || quantity<1 || quantity>item.maxQuantityPerPurchase){
        throw Object.assign(new Error('Snapshot de PH futuro diverge do catalogo.'),{code:'return_shop_ph_snapshot_invalid'});
    }
    const launch=await db.get(`SELECT lp.status,ev.status reset_status FROM clover_prereset_launch_players lp
        JOIN clover_player_reset_events ev ON ev.operation_code=lp.reset_operation_code AND ev.player_id=lp.player_id
        WHERE lp.campaign_key=? AND lp.player_id=? AND lp.outcome='reset'`,[campaignKey,playerId]);
    if(!launch || !['applying','completed'].includes(launch.status) || launch.reset_status!=='applied') return null;
    const character=await require('./preResetCharacterService').getFutureCharacter(db,playerId);
    if(character?.status!=='locked') return null;
    const roll=await db.get('SELECT * FROM clover_prereset_future_rolls WHERE campaign_key=? AND player_id=? AND roll_number=?',[campaignKey,playerId,character.draft.rollNumber]);
    const count=await db.get('SELECT COUNT(*) total FROM clover_prereset_future_rolls WHERE campaign_key=? AND player_id=?',[campaignKey,playerId]);
    if(!roll || !await require('./preResetFuturePromotionService').isFutureAlreadyMaterialized(db,playerId,character,roll,count.total)) return null;
    const relatedId='return-shop:entitlement:'+Number(row.id);
    if(await db.get("SELECT id FROM clover_ph_ledger WHERE player_id=? AND source='return_point_shop_fulfillment' AND related_id=?",[playerId,relatedId])){
        throw Object.assign(new Error('PH ja registrado para direito ativo; reconciliacao necessaria.'),{code:'return_shop_ph_credit_conflict'});
    }
    // This empty projection belongs only to the verified promoted character.
    // The existing PH primitive derives all balances from the canonical ledger.
    return require('./phService').addPreResetPhInTransaction(db,playerId,quantity,'return_point_shop_fulfillment',
        'Materializacao da Loja de Retorno: 1 PH por unidade.',actorId,
        {campaign_key:campaignKey,entitlement_id:Number(row.id),purchase_id:row.purchase_id || null,manual_import_id:row.manual_import_id || null,catalog_item_key:item.itemKey,quantity},relatedId);
}
module.exports={creditFuturePhInTransaction};
