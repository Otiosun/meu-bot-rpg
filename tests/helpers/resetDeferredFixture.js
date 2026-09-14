'use strict';
const {applyFutureCharacterMutation,getFutureCharacter,reviewFutureCharacter}=require('../../helpers/clover/preResetCharacterService');
const {createPreResetPolicyRegistry}=require('../../helpers/clover/preResetPolicyRegistryService');
const {DEFAULT_PRE_RESET_CAMPAIGN_KEY:campaign}=require('../../helpers/clover/preResetCampaignStateService');
function context() {return {actorId:'fixture-admin',env:{PRE_RESET:'ON',PRE_RESET_LAUNCH_ENABLED:'true',PRE_RESET_RETURN_ENABLED:'true'},capabilities:['prereset.review','player.manage','operation.apply'],policyRegistry:createPreResetPolicyRegistry({testOnly:true,policies:{PRE_RESET_MODE:{status:'ENABLED',policyVersion:'deferred-fixture'}}})};}
async function roll(db,id) {
 await db.run(`INSERT INTO clover_prereset_future_rolls
 (campaign_key,player_id,roll_number,kingdom,social_class,race,grimoire,grimoire_rank,grimoire_symbol,magic_rarity,magic_scope,summary,roll_version,kingdom_key,social_class_key,race_key,grimoire_key,magic_rarity_key,roll_payload)
 VALUES (?, ?,1,'Reino Clover','Plebeu','Humano','Grimorio de 3 Folhas','3F','Trevo','Incomum','Misto','fixture','fixture-v1','clover','plebeu','humano','clover_3f','incomum','{}')`,[campaign,id]);
}
async function lock(db,id,rollNumber=1,magicKey='magia_de_algodao') {
 let current=await getFutureCharacter(db,id);
 const draft={...(current?.draft || {}),name:'Deferred Fixture',age:19,gender:'Masculino',appearance:'Asta (Black Clover)',rollNumber,familyKey:'sem_linhagem',magicKey,traits:{aptitude:{key:'olhar_analitico',name:'Olhar Analitico',rarity:'common'},mark:{key:'passo_quieto',name:'Passo Quieto',rarity:'common'},anomaly:null}};
 const prefix='fixture:'+id.replace(/[^a-zA-Z0-9_.:-]/g,'.');
 current=(await applyFutureCharacterMutation(db,id,'fixture-admin',{operationType:current?'submit':'create',operationKey:prefix+':build',expectedRevision:current?.revision || 0,draft})).character;
 if(current.status==='draft') current=(await applyFutureCharacterMutation(db,id,'fixture-admin',{operationType:'submit',operationKey:prefix+':submit',expectedRevision:current.revision,draft})).character;
 for(const action of ['approve','lock'])current=(await reviewFutureCharacter(db,context(),{playerId:id,action,expectedRevision:current.revision,operationKey:prefix+':'+action,reason:'Controlled disposable fixture only'})).character;
 return current;
}
async function reception(db,id) {
 // Canonical appearance approval and history approval, with a completely offline socket.
 const group='fixture@g.us',admin='fixture-admin@s.whatsapp.net';
 const sock={groupMetadata:async()=>({participants:[{id:admin,admin:'admin'}]}),sendMessage:async()=>({key:{id:'fixture-sent'}})};
 const player=await db.get('SELECT personagem_aparencia,personagem_aparencia_normalizada FROM jogadores WHERE id=?',[id]);
 const messageId=`fixture-review-${String(id).replace(/[^a-zA-Z0-9]/g,'-')}`;
 await db.run(`INSERT INTO clover_appearance_reviews (player_id,group_id,message_id,scope,appearance,appearance_normalized,has_image)
 VALUES (?,?,?,'reception',?,?,0)`,[id,group,messageId,player.personagem_aparencia,player.personagem_aparencia_normalizada]);
 const m={key:{id:`fixture-approval-${messageId}`},message:{extendedTextMessage:{contextInfo:{stanzaId:messageId,mentionedJid:[id]}}}};
 await require('../../helpers/clover/appearanceManager').tryHandleAppearanceReviewReply({sock,db,m,idChat:group,reviewerId:admin,text:'aprovar'});
 await require('../../comandos/historiaJogo').executar({sock,db,m,idChat:group,idJogador:admin,body:id,matchedCommand:'!aprovarhistoria'});
}
module.exports={context,roll,lock,reception,campaign};
