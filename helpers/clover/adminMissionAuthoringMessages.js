'use strict';

const { normalizeText } = require('../textUtils');
const { normalizeMissionDraft, getMission } = require('./adminMissionService');
const { exactReward } = require('./playerMissionLifecycleService');
const { createHash } = require('node:crypto');
const { createAdminOperation, simulateAdminOperation, getOperationByCode,
    approveAdminOperation, applyAdminOperation } = require('./adminOperationService');
const { getAdminOperationExecutors } = require('./adminOperationRegistry');

const SOURCE = 'whatsapp_mission_authoring';
const FIELDS = Object.freeze([
    ['Código','𝐂𝐨́𝐝𝐢𝐠𝐨'], ['Nome','𝐍𝐨𝐦𝐞'], ['Rank','𝐑𝐚𝐧𝐤'], ['Tipo','𝐓𝐢𝐩𝐨'],
    ['Modo','𝐌𝐨𝐝𝐨'], ['Local','𝐋𝐨𝐜𝐚𝐥'], ['Vagas','𝐕𝐚𝐠𝐚𝐬'], ['Prazo','𝐏𝐫𝐚𝐳𝐨'],
    ['Risco','𝐑𝐢𝐬𝐜𝐨'], ['Contexto','𝐂𝐨𝐧𝐭𝐞𝐱𝐭𝐨'], ['Objetivo','𝐎𝐛𝐣𝐞𝐭𝐢𝐯𝐨'],
    ['Condições','𝐂𝐨𝐧𝐝𝐢𝐜̧𝐨̃𝐞𝐬'], ['Falha','𝐅𝐚𝐥𝐡𝐚'], ['PH','𝐏𝐇'], ['Yulls','𝐘𝐮𝐥𝐥𝐬'],
    ['Estrelas','𝐄𝐬𝐭𝐫𝐞𝐥𝐚𝐬'], ['Conta para salário','𝐂𝐨𝐧𝐭𝐚 𝐩𝐚𝐫𝐚 𝐬𝐚𝐥𝐚́𝐫𝐢𝐨'],
    ['Anúncio excepcional','𝐀𝐧𝐮́𝐧𝐜𝐢𝐨 𝐞𝐱𝐜𝐞𝐩𝐜𝐢𝐨𝐧𝐚𝐥'], ['Motivo','𝐌𝐨𝐭𝐢𝐯𝐨'],
]);
const TYPES = { combate:'combat', escolta:'escort', investigacao:'investigation', defesa:'defense', diplomacia:'diplomacy', suporte:'support' };
const MODES = { oficial:'official', autonarrada:'auto_narrated', 'auto-narrada':'auto_narrated', 'auto narrada':'auto_narrated' };
const MULTILINE = new Set(['contexto','objetivo','condicoes','falha','risco','anuncio excepcional','motivo']);
const LABELS = new Set(FIELDS.map(([label])=>normalizeText(label)));
function fail(message) {
    const e = new Error(message); e.code='invalid_mission_sheet'; e.status=400; throw e;
}
function divider(symbol, label) {
    return '_'+String.fromCharCode(96)+'─( '+symbol+' )───── '+label+String.fromCharCode(96)+'_';
}
function renderMissionAuthoringTemplate() {
    const field = index => '*'+FIELDS[index][1]+':*';
    return [
        '♧┃𝐅𝐈𝐂𝐇𝐀 𝐃𝐄 𝐌𝐈𝐒𝐒𝐀̃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        '     ──  criação de rascunho  ──','',
        divider('✓','𝗜𝗱𝗲𝗻𝘁𝗶𝗳𝗶𝗰𝗮𝗰̧𝗮̃𝗼'),'',
        ...FIELDS.slice(0,9).map((_,i)=>field(i)),
        '',divider('◆','𝗡𝗮𝗿𝗿𝗮𝘁𝗶𝘃𝗮'),'',
        ...FIELDS.slice(9,13).flatMap((_,i)=>[field(i+9),'>','']),
        divider('✦','𝗥𝗲𝗰𝗼𝗺𝗽𝗲𝗻𝘀𝗮𝘀'),'',
        ...FIELDS.slice(13,19).map((_,i)=>field(i+13)),
    ].join('\n');
}
function readSheetFields(text) {
    const raw=String(text||'');
    if(raw.length>14000) fail('Ficha muito extensa.');
    const fields=Object.create(null);
    let current=null;
    for(const original of raw.split(/\r?\n/)) {
        const line=original.trim();
        if(!line || line.startsWith('♧┃') || line.startsWith('──') || line.startsWith('_'+String.fromCharCode(96)+'─(')) continue;
        if(line.startsWith('>')) {
            if(!current || !MULTILINE.has(current)) fail('Trecho sem campo narrativo.');
            const value=line.slice(1).trim();
            if(value) fields[current]+=(fields[current]?'\n':'')+value;
            continue;
        }
        const separator=line.indexOf(':');
        if(separator===-1) fail('Use os campos da ficha ou linhas iniciadas por > nas seções narrativas.');
        const label=normalizeText(line.slice(0,separator).replace(/[*_~]/g,'').replace(/\x60/g,''));
        if(!LABELS.has(label)) fail('Campo não reconhecido: '+label);
        if(Object.hasOwn(fields,label)) fail('Campo repetido: '+label);
        current=label;
        fields[label]=line.slice(separator+1).replace(/^\s*\*/,'').trim();
    }
    return fields;
}
function integer(raw,label,min=0) {
    const text=String(raw||'').trim();
    if(!/^(?:\d+|\d{1,3}(?:\.\d{3})+)$/.test(text)) fail(label+' deve ter um valor inteiro, sem faixa.');
    const value=Number(text.replace(/\./g,''));
    if(!Number.isSafeInteger(value)||value<min) fail(label+' inválido.');
    return value;
}
function deadline(raw) {
    const match=String(raw||'').match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
    if(!match) fail('Prazo: use DD/MM/AAAA HH:mm (Brasília).');
    const [,d,m,y,h,min]=match;
    const local=Date.UTC(Number(y),Number(m)-1,Number(d),Number(h),Number(min));
    const date=new Date(local);
    if(date.getUTCFullYear()!==Number(y)||date.getUTCMonth()+1!==Number(m)||date.getUTCDate()!==Number(d)||date.getUTCHours()!==Number(h)||date.getUTCMinutes()!==Number(min)) fail('Prazo inválido.');
    return new Date(local+3*3600000).toISOString();
}
function parseMissionAuthoringSheet(text) {
    const f=readSheetFields(text);
    const required=key=>{if(!String(f[key]||'').trim()) fail('Preencha '+key+'.');return f[key].trim();};
    const rank=required('rank').toUpperCase();
    const missionType=TYPES[normalizeText(required('tipo'))];
    const mode=MODES[normalizeText(required('modo'))];
    if(!missionType || !mode) fail('Tipo ou modo inválido. Use os nomes da ficha.');
    const salary=normalizeText(required('conta para salario'));
    if(!['sim','nao'].includes(salary)) fail('Conta para salário: sim ou não.');
    const reward={};
    for(const [key,label] of [['ph','PH'],['yulls','Yulls'],['estrelas','Estrelas']]) {
        const n=integer(required(key),label);
        reward[key==='estrelas'?'stars':key]=[n,n];
    }
    if(f['anuncio excepcional']) reward.exceptionalAnnouncement=f['anuncio excepcional'];
    const mission=normalizeMissionDraft({
        missionKey:required('codigo'),title:required('nome'),rank,missionType,mode,
        location:required('local'),slots:integer(required('vagas'),'Vagas',1),deadlineAt:deadline(required('prazo')),
        risk:required('risco'),description:required('contexto')+'\n\nObjetivo:\n'+required('objetivo'),
        specialConditions:f.condicoes||null,failureConsequence:f.falha||null,countsForSalary:salary==='sim',reward,
    });
    exactReward(mission.reward);
    const reason=required('motivo');
    if(reason.length>1000) fail('Motivo muito extenso.');
    return {mission,reason};
}
function requireCaps(actor,caps) {
    if(!actor?.id || !caps.every(cap=>actor.capabilities?.includes(cap))) {
        const e=new Error('Seu perfil não possui permissão para esta ação.'); e.code='missing_capability'; e.status=403; throw e;
    }
}
function makeOperationKey(actor, messageKey) {
    if(!String(messageKey||'').trim()) fail('Não foi possível identificar a mensagem. Reenvie o comando.');
    return 'mission-wa:'+createHash('sha256').update(JSON.stringify([actor.id,messageKey])).digest('hex');
}
function assertAuthoringOperation(operation,actor) {
    if(operation?.metadata?.source!==SOURCE || operation.actor?.id!==actor.id ||
        operation.targets?.length!==1 || operation.targets[0].kind!=='system' || operation.targets[0].systemKey!=='clover' ||
        operation.actions?.length!==1 || !['system.mission.create','system.mission.status.transition'].includes(operation.actions[0].type) ||
        (operation.actions[0].type==='system.mission.status.transition' && operation.actions[0].payload?.status!=='published')) {
        const e=new Error('Esta confirmação não pertence à sua solicitação de missão.');e.code='mission_operation_forbidden';e.status=403;throw e;
    }
}
async function previewAuthoring(db,{actor,messageKey,missionKey,sheet,reason}) {
    requireCaps(actor,['mission.manage','operation.draft','operation.simulate']);
    let action,title;
    if(sheet!==undefined) {
        const draft=parseMissionAuthoringSheet(sheet);
        reason=draft.reason;
        action={type:'system.mission.create',payload:draft.mission};
        title='Criar missão: '+draft.mission.title;
    } else {
        missionKey=String(missionKey||'').trim().toLowerCase();
        if(!/^[a-z0-9][a-z0-9_.:-]{2,119}$/.test(missionKey)) fail('Código da missão inválido.');
        const current=await getMission(db,missionKey);
        if(!current) fail('Missão não encontrada.');
        exactReward(current.reward);
        if(!String(reason||'').trim()||String(reason).length>1000) fail('Informe o motivo da publicação.');
        action={type:'system.mission.status.transition',payload:{missionKey,status:'published'}};
        title='Publicar missão: '+current.title;
    }
    const executors=getAdminOperationExecutors();
    const created=await createAdminOperation(db,{title,reason,targets:[{kind:'system',systemKey:'clover'}],
        actions:[action],metadata:{source:SOURCE},idempotencyKey:makeOperationKey(actor,messageKey)},actor,{executors});
    assertAuthoringOperation(created.operation,actor);
    if(created.operation.status==='draft') return (await simulateAdminOperation(db,created.operation.code,actor,{executors})).operation;
    return getOperationByCode(db,created.operation.code,{includeUnits:true});
}
async function confirmAuthoring(db,{actor,code}) {
    requireCaps(actor,['mission.manage','operation.apply']);
    const current=await getOperationByCode(db,code,{includeUnits:true});
    assertAuthoringOperation(current,actor);
    if(current.status==='applied') return {ok:true,duplicate:true,operation:current};
    if(!['simulated','approved'].includes(current.status)) fail('Operação não aguarda confirmação. Consulte a Central ADM.');
    if(current.status==='simulated') await approveAdminOperation(db,code,actor);
    return applyAdminOperation(db,code,actor,{executors:getAdminOperationExecutors()});
}
module.exports={renderMissionAuthoringTemplate,parseMissionAuthoringSheet,previewAuthoring,confirmAuthoring,requireCaps};
