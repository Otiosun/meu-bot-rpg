'use strict';
const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getQuotedText, getMessageContextInfo } = require('../helpers/messageContext');
const { isSameUser } = require('../helpers/groupAccess');
const { getAdminActorAccess } = require('../helpers/clover/adminAccessService');
const { renderMissionAuthoringTemplate, previewAuthoring, confirmAuthoring, requireCaps } = require('../helpers/clover/adminMissionAuthoringMessages');
const { renderMissionDetail } = require('../helpers/clover/playerMissionBoardMessages');

function renderPreview(operation) {
    const mission=operation.units?.[0]?.after;
    if(operation.status!=='simulated'||!mission) return '> Operação '+operation.code+': '+operation.status+'. Consulte a Central ADM.';
    return [
        '♧┃𝐏𝐑𝐄́𝐕𝐈𝐀 𝐃𝐄 𝐌𝐈𝐒𝐒𝐀̃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        '     ──  nada foi publicado  ──','',
        renderMissionDetail(mission).split('\n').filter(line=>!line.includes(COMMAND_PREFIX+'missao ')&&!line.includes('𝗣𝗮𝗿𝘁𝗶𝗰𝗶𝗽𝗮𝗿')).join('\n'),
        '', '*𝐎𝐩𝐞𝐫𝐚𝐜̧𝐚̃𝐨:* '+operation.code,
        '*𝐒𝐢𝐭𝐮𝐚𝐜̧𝐚̃𝐨:* '+(mission.status==='draft'?'Criar rascunho':'Publicar missão'),
        '', '*̣'+COMMAND_PREFIX+'confirmarmissao '+operation.code+'*',
        '> Confirmar esta operação.',
    ].join('\n');
}
module.exports={
    nome:COMMAND_PREFIX+'modelomissao',
    aliases:[COMMAND_PREFIX+'modelomissão',COMMAND_PREFIX+'criarmissao',COMMAND_PREFIX+'criarmissão',COMMAND_PREFIX+'publicarmissao',COMMAND_PREFIX+'publicarmissão',COMMAND_PREFIX+'confirmarmissao',COMMAND_PREFIX+'confirmarmissão'],
    descricao:'ADM: ficha, prévia e confirmação de criação/publicação de missão.',
    oculto:true, groupBypass:true,
    executar:async ({sock,m,idChat,idJogador,db,body,matchedCommand})=>{
        const reply=text=>sendReply({sock,m,idChat,text});
        // Draft content and operation tokens are kept out of player groups.
        if(String(idChat||'').endsWith('@g.us')) return reply('> Use os comandos de criação de missão no privado do bot.');
        const access=await getAdminActorAccess(db,idJogador);
        if(!access.ok) return reply('> Seu perfil não possui acesso à criação de missões.');
        const actor=access.actor;
        try {
            requireCaps(actor,['mission.manage']);
            const cmd=String(matchedCommand||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
            const text=String(body||'').trim();
            if(cmd.includes('confirmarmissao')) {
                if(!/^OP-[A-F0-9]{6}$/i.test(text)) return reply('> Use '+COMMAND_PREFIX+'confirmarmissao OP-XXXXXX.');
                const result=await confirmAuthoring(db,{actor,code:text.toUpperCase()});
                if(!result.ok||result.operation.status!=='applied') return reply('> Operação não concluída. Consulte '+result.operation.code+' na Central ADM.');
                const draft=result.operation.actions[0].type==='system.mission.create';
                const key=result.operation.actions[0].payload.missionKey;
                return reply([
                    '♧┃'+(draft?'𝐌𝐈𝐒𝐒𝐀̃𝐎 𝐂𝐑𝐈𝐀𝐃𝐀':'𝐌𝐈𝐒𝐒𝐀̃𝐎 𝐏𝐔𝐁𝐋𝐈𝐂𝐀𝐃𝐀')+' 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫','',
                    '*𝐂𝐨́𝐝𝐢𝐠𝐨:* '+key,
                    result.duplicate?'> Esta operação já havia sido aplicada.':draft?'> Rascunho registrado.':'> Disponível no mural.',
                    ...(draft?['','*̣'+COMMAND_PREFIX+'publicarmissao '+key+' | <motivo>*']:[])
                ].join('\n'));
            }
            if(cmd.includes('criarmissao')) {
                const context=getMessageContextInfo(m);
                const quoted=context?.participant && isSameUser(context.participant,idJogador)?getQuotedText(m):'';
                const sheet=text||quoted;
                if(!sheet) return reply('> Responda à sua ficha preenchida com '+COMMAND_PREFIX+'criarmissao.');
                return reply(renderPreview(await previewAuthoring(db,{actor,messageKey:m?.key?.id,sheet})));
            }
            if(cmd.includes('publicarmissao')) {
                const match=text.match(/^(\S+)\s*\|\s*([\s\S]+)$/);
                if(!match) return reply('> Use '+COMMAND_PREFIX+'publicarmissao <código> | <motivo>.');
                return reply(renderPreview(await previewAuthoring(db,{actor,messageKey:m?.key?.id,missionKey:match[1],reason:match[2]})));
            }
            return reply(renderMissionAuthoringTemplate()+'\n\n> Tipos: Combate, Escolta, Investigação, Defesa, Diplomacia, Suporte.\n> Modos: Oficial ou Auto-Narrada.\n> Prazo: DD/MM/AAAA HH:mm (Brasília).\n> Recompensas: valores inteiros fixos; use 0 quando não houver.\n> Conta para salário: sim ou não.\n\n> Preencha e responda à sua ficha com '+COMMAND_PREFIX+'criarmissao.');
        } catch(error) {
            if(error?.code && Number(error.status)>=400 && Number(error.status)<500) return reply('> '+error.message);
            throw error;
        }
    },
};
