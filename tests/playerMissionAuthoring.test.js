'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const sqlite3=require('sqlite3');
const {open}=require('sqlite');
const {parseMissionAuthoringSheet,previewAuthoring,confirmAuthoring}=require('../helpers/clover/adminMissionAuthoringMessages');
const {getMission}=require('../helpers/clover/adminMissionService');
const {getRoleCapabilities}=require('../helpers/clover/adminOperationContract');
const actor={id:'fixture-author',role:'owner',capabilities:getRoleCapabilities('owner')};
const deadline=new Date(Date.now()+86400000*7);
const format=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(deadline).replace(',','');
function sheet(){
    return ['♧┃𝐅𝐈𝐂𝐇𝐀 𝐃𝐄 𝐌𝐈𝐒𝐒𝐀̃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        '*𝐂𝐨́𝐝𝐢𝐠𝐨:* patrulha-r32','*𝐍𝐨𝐦𝐞:* Patrulha','Rank: D','Tipo: Investigação','Modo: Auto-Narrada',
        'Local: Capital','Vagas: 4','Prazo: '+format,'Risco: Baixo',
        'Contexto:','> Uma patrulha está desaparecida.','> Os moradores pedem ajuda.',
        'Objetivo:','> Encontre os registros da patrulha.','Condições:','Falha:',
        'PH: 10','Yulls: 1.200','Estrelas: 1','Conta para salário: sim','Anúncio excepcional:',
        'Motivo: Conteúdo inicial da temporada'].join('\n');
}
test('ficha admite estilo Clover e narrativa multilinha, exige valores-base fixos explícitos',()=>{
    const {mission}=parseMissionAuthoringSheet(sheet());
    assert.equal(mission.missionKey,'patrulha-r32');
    assert.deepEqual(mission.reward.ph,[10,10]);
    assert.deepEqual(mission.reward.yulls,[1200,1200]);
    assert.equal(mission.mode,'auto_narrated');
    assert.match(mission.description,/moradores pedem ajuda/);
    assert.throws(()=>parseMissionAuthoringSheet(sheet().replace('PH: 10','PH: 8-10')),/valor inteiro/);
    assert.throws(()=>parseMissionAuthoringSheet(sheet().replace('PH: 10','PH:')),/Preencha/);
    assert.throws(()=>parseMissionAuthoringSheet(sheet()+'\nPH: 99'),/repetido/);
    assert.throws(()=>parseMissionAuthoringSheet(sheet().replace('Yulls: 1.200','Yulls: 8.000')),/justificativa excepcional/);
    assert.throws(()=>parseMissionAuthoringSheet(sheet().replace('Prazo: '+format,'Prazo: 31/02/2027 21:00')),/Prazo inválido/);
});
test('ADM: prévia não cria missão; confirmação cria rascunho, publicação é operação distinta; replay seguro',async t=>{
    const db=await open({filename:':memory:',driver:sqlite3.Database});
    t.after(()=>db.close());
    await assert.rejects(()=>previewAuthoring(db,{actor:{id:'unauthorized',capabilities:[]},messageKey:'a',sheet:sheet()}),e=>e.code==='missing_capability');
    const op=await previewAuthoring(db,{actor,messageKey:'create-fixture',sheet:sheet()});
    assert.equal(op.status,'simulated');
    assert.equal(await getMission(db,'patrulha-r32'),null);
    await assert.rejects(()=>confirmAuthoring(db,{actor:{...actor,id:'second-author'},code:op.code}),e=>e.code==='mission_operation_forbidden');
    const first=await confirmAuthoring(db,{actor,code:op.code});
    assert.equal(first.ok,true);
    assert.equal((await getMission(db,'patrulha-r32')).status,'draft');
    assert.equal((await confirmAuthoring(db,{actor,code:op.code})).duplicate,true);
    const publish=await previewAuthoring(db,{actor,messageKey:'publish-fixture',missionKey:'patrulha-r32',reason:'Abrir mural'});
    assert.equal(publish.status,'simulated');
    assert.equal((await getMission(db,'patrulha-r32')).status,'draft');
    assert.equal((await confirmAuthoring(db,{actor,code:publish.code})).ok,true);
    assert.equal((await getMission(db,'patrulha-r32')).status,'published');
});
