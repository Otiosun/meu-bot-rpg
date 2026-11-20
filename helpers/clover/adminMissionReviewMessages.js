'use strict';
const { COMMAND_PREFIX }=require('../../config/bot');
const READ_MORE_BREAK='\u031d'.repeat(1024);
const STATUS={submitted:'Aguardando avaliação',changes_requested:'Ajustes solicitados',approved:'Aprovada',rejected:'Reprovada'};
const DECISION={approve:'Aprovada',return:'Devolvida',reject:'Reprovada'};
function clean(value,max=6000){
    return String(value??'').slice(0,max).replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\u031d]/g,'')
        .replace(/[*_~]/g,'').replace(/\x60/g,'').replace(/[<>]/g,'').trim();
}
function line(value,max=180){return clean(value,max).replace(/\s+/g,' ')||'—';}
function section(symbol,title){return ['', '_'+String.fromCharCode(96)+'─( '+symbol+' )───── '+title+String.fromCharCode(96)+'_',''];}
function command(value){return '*̣'+COMMAND_PREFIX+value+'*';}
function formatNumber(value){return Number(value).toLocaleString('pt-BR');}
function renderReviewCards({total,page,pages,cards}){
    const lines=['♧┃𝐀𝐕𝐀𝐋𝐈𝐀𝐂̧𝐎̃𝐄𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫','     ──  missões ᥱ entregas  ──',''];
    if(!total)lines.push('> Nenhuma entrega aguardando avaliação.');
    else if(!cards.length)lines.push('> Nenhuma entrega nesta página. Atualize a fila.');
    else {
        lines.push('*𝐏𝐞𝐧𝐝𝐞𝐧𝐭𝐞𝐬:* '+total);
        for(const card of cards)lines.push('','*'+line(card.title)+'* — Rank '+line(card.rank),
            '> '+line(card.name)+(card.squad?' • '+line(card.squad):''),
            card.code?command('avaliarmissao '+card.code):'> Entrega sem código. Consulte a Central ADM.');
    }
    if(pages>1){
        lines.push('','> Página '+page+'/'+pages);
        if(page>1)lines.push(command('avaliacoesmissoes '+(page-1)));
        if(page<pages)lines.push(command('avaliacoesmissoes '+(page+1)));
    }
    return lines.join('\n');
}
function renderReviewCard(card){
    const {dossier}=card, {contract,participation}=dossier;
    const report=dossier.submissions.find(s=>s.revision===card.revision);
    const lines=[
        '♧┃𝐅𝐈𝐂𝐇𝐀 𝐃𝐄 𝐀𝐕𝐀𝐋𝐈𝐀𝐂̧𝐀̃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫',
        '     ──  '+line(contract.title)+'  ──','',
        '*𝐏𝐞𝐬𝐬𝐨𝐚:* '+line(card.name),
        '*𝐄𝐬𝐭𝐚𝐝𝐨:* '+(card.current?(STATUS[participation.status]||'Indisponível'):'Entrega anterior'),
        '*𝐄𝐧𝐭𝐫𝐞𝐠𝐚:* '+card.revision,
        READ_MORE_BREAK,
        ...section('◆','𝗠𝗶𝘀𝘀𝗮̃𝗼'),
        '*𝐑𝐚𝐧𝐤:* '+line(contract.rank),
        '*𝐌𝐨𝐝𝐨:* '+(contract.mode==='auto_narrated'?'Missão Auto-Narrada':'Missão Oficial'),
        '*𝐋𝐨𝐜𝐚𝐥:* '+line(contract.location,240),'',
        clean(contract.description,6000),
        ...(contract.specialConditions?['','*𝐂𝐨𝐧𝐝𝐢𝐜̧𝐨̃𝐞𝐬:*',clean(contract.specialConditions,3000)]:[]),
        ...(contract.failureConsequence?['','*𝐅𝐚𝐥𝐡𝐚:*',clean(contract.failureConsequence,3000)]:[]),
        ...section('✎','𝗔𝘁𝘂𝗮𝗰̧𝗮̃𝗼'),report?clean(report.text,6000):'> Registro da entrega indisponível.',
        ...section('✦','𝗥𝗲𝗰𝗼𝗺𝗽𝗲𝗻𝘀𝗮𝘀'),
        '*𝐏𝐇:* '+formatNumber(contract.reward.ph),
        '*𝐘𝐮𝐥𝐥𝐬:* '+formatNumber(contract.reward.yulls),
        '*𝐄𝐬𝐭𝐫𝐞𝐥𝐚𝐬:* '+formatNumber(contract.reward.stars),
        '> Recompensa-base definida na missão.',
        '*𝐒𝐞𝐫𝐯𝐢𝐜̧𝐨 𝐀𝐃𝐌:* '+(contract.countsForSalary?'Elegível para PA':'Não contabiliza PA'),
    ];
    if(dossier.reviews.length){
        lines.push(...section('◇','𝗛𝗶𝘀𝘁𝗼́𝗿𝗶𝗰𝗼'));
        for(const item of dossier.reviews)lines.push('> Entrega '+item.revision+' · '+DECISION[item.decision]+(item.reason?'\n'+clean(item.reason,2000):''));
    }
    if(card.active && report){
        lines.push(...section('✓','𝗗𝗲𝗰𝗶𝘀𝗮̃𝗼'),command('avaliarmissao '+card.code+' aprovar'),
            '',command('avaliarmissao '+card.code+' devolver | motivo'),'',command('avaliarmissao '+card.code+' reprovar | motivo'));
    }else if(!card.current){
        lines.push('','> Esta versão não pode mais ser avaliada.');
        if(card.currentCode)lines.push(command('avaliarmissao '+card.currentCode));
    }
    return lines.join('\n');
}
function renderReviewDecision(result){
    const row=result.participation;
    const header=row.status==='approved'?'𝐀𝐕𝐀𝐋𝐈𝐀𝐃𝐎.':row.status==='rejected'?'𝐌𝐈𝐒𝐒𝐀̃𝐎 𝐑𝐄𝐏𝐑𝐎𝐕𝐀𝐃𝐀':'𝐀𝐉𝐔𝐒𝐓𝐄𝐒 𝐒𝐎𝐋𝐈𝐂𝐈𝐓𝐀𝐃𝐎𝐒';
    const lines=['♧┃'+header+' 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫','',
        '*'+line(row.title)+'*','*𝐄𝐧𝐭𝐫𝐞𝐠𝐚:* '+row.submissionRevision,'*𝐄𝐬𝐭𝐚𝐝𝐨:* '+STATUS[row.status]];
    if(row.reviewReason)lines.push('','> '+clean(row.reviewReason,2000));
    if(row.status==='approved'){
        lines.push(...section('✦','𝗥𝗲𝗰𝗼𝗺𝗽𝗲𝗻𝘀𝗮𝘀'),'*𝐏𝐇:* '+formatNumber(row.reward.ph),'*𝐘𝐮𝐥𝐥𝐬:* '+formatNumber(row.reward.yulls),'*𝐄𝐬𝐭𝐫𝐞𝐥𝐚𝐬:* '+formatNumber(row.reward.stars),
            '',result.duplicate?'> Recompensa já registrada. Nenhum valor adicional.':'> Recompensa-base registrada.');
    }
    if(row.status==='approved' && !result.duplicate && result.receipt?.servicePoints>0)
        lines.push(...section('◆','𝗦𝗲𝗿𝘃𝗶𝗰̧𝗼 𝗔𝗗𝗠'),'*𝐏𝐀:* +'+formatNumber(result.receipt.servicePoints),'> Registrados na folha de serviço.');
    lines.push('',command('avaliacoesmissoes'));
    return lines.join('\n');
}
module.exports={renderReviewCards,renderReviewCard,renderReviewDecision};
