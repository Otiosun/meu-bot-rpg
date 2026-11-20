'use strict';
const {COMMAND_PREFIX}=require('../config/bot');
const {sendReply}=require('../helpers/chatReply');
const {getAdminActorAccess}=require('../helpers/clover/adminAccessService');
const {requireReviewAccess,listReviewCards,getReviewCard,decideReviewCard}=require('../helpers/clover/adminMissionReviewService');
const {renderReviewCards,renderReviewCard,renderReviewDecision}=require('../helpers/clover/adminMissionReviewMessages');
const {normalizeCommandText}=require('../helpers/textUtils');
const decisions={aprovar:'approve',devolver:'return',reprovar:'reject'};
module.exports={
    nome:COMMAND_PREFIX+'avaliacoesmissoes',
    aliases:[COMMAND_PREFIX+'avaliaçõesmissões',COMMAND_PREFIX+'avaliarmissao',COMMAND_PREFIX+'avaliarmissão'],
    descricao:'ADM: consulta e avaliação das entregas de missões.',
    oculto:true,groupBypass:true,
    executar:async({sock,m,idChat,idJogador,db,body,matchedCommand})=>{
        const reply=text=>sendReply({sock,m,idChat,text});
        if(!/@(?:lid|s\.whatsapp\.net)$/.test(String(idChat||'')))return reply('> Consulte as avaliações no privado do bot.');
        const access=await getAdminActorAccess(db,idJogador);
        if(!access?.ok)return reply('> Seu perfil não possui permissão para avaliar missões.');
        try{
            const actor=access.actor;
            requireReviewAccess(actor);
            const input=String(body||'').trim();
            if(!normalizeCommandText(matchedCommand||'').includes('avaliarmissao')){
                const page=input?Number(input):1;
                if(!Number.isSafeInteger(page)||page<1||page>10000||input&&!/^\d{1,5}$/.test(input))return reply('> Use '+COMMAND_PREFIX+'avaliacoesmissoes [página].');
                return reply(renderReviewCards(await listReviewCards(db,actor,page)));
            }
            const match=input.match(/^(MR-[0-9A-F]{12})(?:\s+(aprovar|devolver|reprovar)(?:\s*\|\s*([\s\S]+))?)?$/i);
            if(!match)return reply('> Use '+COMMAND_PREFIX+'avaliacoesmissoes para consultar os códigos das entregas.');
            const [,code,decision,reason]=match;
            if(!decision)return reply(renderReviewCard(await getReviewCard(db,actor,code)));
            return reply(renderReviewDecision(await decideReviewCard(db,actor,{code,decision:decisions[decision.toLowerCase()],reason})));
        }catch(error){
            if(error?.code&&Number(error.status)>=400&&Number(error.status)<500)return reply('> '+error.message);
            throw error;
        }
    },
};
