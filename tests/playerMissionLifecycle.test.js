'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    ensureMissionParticipationSchema, joinMission, startMission, submitMission,
    getMyMission, listPendingReviews, reviewMission,
} = require('../helpers/clover/playerMissionLifecycleService');

async function fixture({ slots = 3, reward = { ph: [10, 10], yulls: [1200, 1200], stars: [1, 1] },
    mode = 'official', status = 'published' } = {}) {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec('PRAGMA foreign_keys = ON');
    await db.exec('CREATE TABLE jogadores (id TEXT PRIMARY KEY, reward_balance INTEGER NOT NULL DEFAULT 0)');
    for (const id of ['player-a', 'player-b', 'player-c', 'player-d'])
        await db.run('INSERT INTO jogadores(id) VALUES (?)', [id]);
    await ensureMissionParticipationSchema(db);
    const future = new Date(Date.now() + 86400000).toISOString();
    await db.run(
        'INSERT INTO clover_missions (mission_key, status, revision, title, rank, mode, location, mission_type, risk, slots, deadline_at, reward_json, description, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['passe-fronteira', status, 2, 'Ecos na fronteira', 'D', mode, 'Capital', 'investigation',
            'Baixo', slots, future, JSON.stringify(reward), 'Investigue o fenômeno.', '{}']
    );
    return db;
}
const deps = {
    async preparePayout() {},
    async creditReward(db, { playerId, reward }) {
        const amount = reward.ph + reward.yulls + reward.stars;
        await db.run('UPDATE jogadores SET reward_balance=reward_balance+? WHERE id=?', [amount, playerId]);
        return { phLedgerId: 91, yullsLedgerId: 92, starsTransactionId: 93 };
    },
};
async function readyToReview(db, playerId = 'player-a') {
    await joinMission(db, { missionKey: 'passe-fronteira', playerId });
    await startMission(db, { missionKey: 'passe-fronteira', playerId });
    await submitMission(db, { missionKey: 'passe-fronteira', playerId, text: 'Eu investiguei as ruínas e relatei o que encontrei.' });
}
test('inscrição guarda snapshot fixo; replay não ocupa uma segunda vaga', async (t) => {
    const db = await fixture({ slots: 1 });
    t.after(() => db.close());
    const a = await joinMission(db, { missionKey: 'passe-fronteira', playerId: 'player-a' });
    assert.equal(a.duplicate, false);
    assert.deepEqual(a.participation.reward, { ph: 10, yulls: 1200, stars: 1 });
    assert.equal((await joinMission(db, { missionKey: 'passe-fronteira', playerId: 'player-a' })).duplicate, true);
    await assert.rejects(() => joinMission(db, { missionKey: 'passe-fronteira', playerId: 'player-b' }),
        (error) => error.code === 'mission_full');
    await db.run('UPDATE clover_missions SET title = ?, reward_json = ? WHERE mission_key = ?',
        ['Alterada à força', JSON.stringify({ ph: [99, 99], yulls: [99, 99], stars: [0, 0] }), 'passe-fronteira']);
    assert.equal((await getMyMission(db, 'passe-fronteira', 'player-a')).title, 'Ecos na fronteira');
});
test('missões com faixa variável, extra, fechadas ou vencidas não aceitam inscrição', async (t) => {
    const db = await fixture({ reward: { ph: [9, 10], yulls: [1200, 1200], stars: [1, 1] } });
    t.after(() => db.close());
    await assert.rejects(() => joinMission(db, { missionKey: 'passe-fronteira', playerId: 'player-a' }),
        (error) => error.code === 'mission_reward_not_fixed');
    await db.run('UPDATE clover_missions SET reward_json=? WHERE mission_key=?',
        [JSON.stringify({ ph: [10, 10], yulls: [1200, 1200], stars: [1, 1], extra: 'item não integrado' }), 'passe-fronteira']);
    await assert.rejects(() => joinMission(db, { missionKey: 'passe-fronteira', playerId: 'player-a' }),
        (error) => error.code === 'mission_extra_not_automated');
    await db.run('UPDATE clover_missions SET status=? WHERE mission_key=?', ['closed', 'passe-fronteira']);
    await assert.rejects(() => joinMission(db, { missionKey: 'passe-fronteira', playerId: 'player-a' }),
        (error) => error.code === 'mission_not_found');
});
test('entrega, revisão humana e pagamento atômico sobrevivem a replay', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await readyToReview(db);
    assert.equal((await listPendingReviews(db)).length, 1);
    const input = { missionKey: 'passe-fronteira', playerId: 'player-a', actorId: 'adm-1', decision: 'approve' };
    const first = await reviewMission(db, input, deps);
    assert.equal(first.duplicate, false);
    assert.equal(first.participation.status, 'approved');
    assert.deepEqual(first.receipt.reward, { ph: 10, yulls: 1200, stars: 1 });
    const again = await reviewMission(db, input, deps);
    assert.equal(again.duplicate, true);
    const player = await db.get('SELECT reward_balance FROM jogadores WHERE id=?', ['player-a']);
    assert.equal(player.reward_balance, 1211);
    const receipts = await db.get('SELECT COUNT(*) AS total FROM clover_mission_payout_receipts');
    assert.equal(receipts.total, 1);
    assert.equal((await listPendingReviews(db)).length, 0);
    await assert.rejects(() => reviewMission(db, { ...input, decision: 'reject', reason: 'Motivo de recusa' }, deps),
        (error) => error.code === 'mission_wrong_status');
});
test('erro na metade do pagamento desfaz saldo, recibo e aprovação', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await readyToReview(db);
    await assert.rejects(() => reviewMission(db,
        { missionKey: 'passe-fronteira', playerId: 'player-a', actorId: 'adm-1', decision: 'approve' },
        {
            ...deps,
            async creditReward(db, context) {
                await deps.creditReward(db, context);
                throw new Error('falha simulada antes do recibo');
            },
        }), /falha simulada/);
    assert.equal((await getMyMission(db, 'passe-fronteira', 'player-a')).status, 'submitted');
    assert.equal((await db.get('SELECT reward_balance FROM jogadores WHERE id=?', ['player-a'])).reward_balance, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_mission_payout_receipts')).total, 0);
});
test('devolução exige motivo, permite reenvio; player não lê participação alheia', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await readyToReview(db);
    const input = { missionKey: 'passe-fronteira', playerId: 'player-a', actorId: 'adm-1', decision: 'return' };
    await assert.rejects(() => reviewMission(db, input, deps), (error) => error.code === 'invalid_review_reason');
    const returned = await reviewMission(db, { ...input, reason: 'Faltou evidência.' }, deps);
    assert.equal(returned.participation.status, 'changes_requested');
    assert.equal(await getMyMission(db, 'passe-fronteira', 'player-b'), null);
    const resubmitted = await submitMission(db, {
        missionKey: 'passe-fronteira', playerId: 'player-a', text: 'Agora apresento os registros, as testemunhas e os resultados.',
    });
    assert.equal(resubmitted.participation.submissionRevision, 2);
    await reviewMission(db, { ...input, decision: 'reject', reason: 'Critérios não atendidos.' }, deps);
    const wallet = await db.get('SELECT reward_balance FROM jogadores WHERE id=?', ['player-a']);
    assert.equal(wallet.reward_balance, 0);
});
test('snapshot adulterado é detectado antes de avaliar e creditar', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await readyToReview(db);
    await db.run('UPDATE clover_mission_participations SET snapshot_json=? WHERE mission_key=?',
        ['{"missionKey":"passe-fronteira","reward":{"ph":100000}}', 'passe-fronteira']);
    await assert.rejects(
        () => reviewMission(db, { missionKey: 'passe-fronteira', playerId: 'player-a', actorId: 'adm-1', decision: 'approve' }, deps),
        (error) => error.code === 'mission_snapshot_corrupt'
    );
    assert.equal((await db.get('SELECT reward_balance FROM jogadores WHERE id=?', ['player-a'])).reward_balance, 0);
});

test('undo administrativo não despublica contrato com jogador inscrito', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await joinMission(db, { missionKey: 'passe-fronteira', playerId: 'player-a' });
    const { getMission, restoreMissionSnapshotInTransaction } = require('../helpers/clover/adminMissionService');
    const current = await getMission(db, 'passe-fronteira');
    await assert.rejects(
        () => restoreMissionSnapshotInTransaction(db, current, { ...current, status: 'draft' }, 'admin-1'),
        (error) => error.code === 'mission_published_contract_locked'
    );
    assert.equal((await getMission(db, 'passe-fronteira')).status, 'published');
});

test('autonarrada começa no aceite e diário privado conserva histórico após encerramento', async t => {
    const db = await fixture({mode:'auto_narrated'});
    t.after(() => db.close());
    const { listMyMissions } = require('../helpers/clover/playerMissionLifecycleService');
    const joined = await joinMission(db,{missionKey:'passe-fronteira',playerId:'player-a'});
    assert.equal(joined.participation.status,'in_progress');
    await submitMission(db,{missionKey:'passe-fronteira',playerId:'player-a',text:'Investiguei a região e encontrei os sinais da patrulha.'});
    await db.run("UPDATE clover_missions SET status='closed' WHERE mission_key=?",['passe-fronteira']);
    const mine = await listMyMissions(db,'player-a');
    assert.equal(mine.total,1);
    assert.equal(mine.missions[0].status,'submitted');
    assert.equal((await listMyMissions(db,'player-b')).total,0);
    assert.equal((await listMyMissions(db,'player-a',{page:2})).missions.length,0);
});

test('a revisão vinculada a entrega antiga não paga uma nova versão', async t => {
    const db=await fixture();
    t.after(()=>db.close());
    await readyToReview(db);
    const input={missionKey:'passe-fronteira',playerId:'player-a',actorId:'adm-1'};
    await reviewMission(db,{...input,decision:'return',reason:'Detalhe as evidências.',expectedSubmissionRevision:1},deps);
    await submitMission(db,{...input,text:'Relato revisado com testemunhas e provas adicionais.'});
    await assert.rejects(()=>reviewMission(db,{...input,decision:'approve',expectedSubmissionRevision:1},deps),
        e=>e.code==='mission_review_conflict');
    assert.equal((await getMyMission(db,input.missionKey,input.playerId)).status,'submitted');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_mission_payout_receipts')).n,0);
    assert.equal((await reviewMission(db,{...input,decision:'approve',expectedSubmissionRevision:2},deps)).participation.status,'approved');
});

test('dossiê preserva relato anterior e devolução, contrato aceito e identidade do avaliador apenas para staff', async t => {
    const db=await fixture();
    t.after(()=>db.close());
    const {getMissionReviewDossier}=require('../helpers/clover/playerMissionLifecycleService');
    await readyToReview(db);
    const input={missionKey:'passe-fronteira',playerId:'player-a',actorId:'adm-1'};
    const original=(await getMyMission(db,input.missionKey,input.playerId)).submissionText;
    await reviewMission(db,{...input,decision:'return',reason:'Faltou mencionar as testemunhas.',expectedSubmissionRevision:1},deps);
    await submitMission(db,{...input,text:'Relato revisado: testemunhas, registros e investigação completa.'});
    await db.run('UPDATE clover_missions SET description=? WHERE mission_key=?',['Alteração posterior.',input.missionKey]);
    const dossier=await getMissionReviewDossier(db,input.missionKey,input.playerId,{staff:true});
    assert.equal(dossier.contract.description,'Investigue o fenômeno.');
    assert.equal(dossier.submissions.length,2);
    assert.equal(dossier.submissions[0].text,original);
    assert.equal(dossier.reviews[0].decision,'return');
    assert.equal(dossier.reviews[0].actorId,'adm-1');
    assert.equal(dossier.reviews[0].revision,1);
    const own=await getMissionReviewDossier(db,input.missionKey,input.playerId);
    assert.ok(!Object.hasOwn(own.reviews[0],'actorId'));
    assert.equal(await getMissionReviewDossier(db,input.missionKey,'player-b'),null);
    await reviewMission(db,{...input,decision:'approve',expectedSubmissionRevision:2},deps);
    await reviewMission(db,{...input,decision:'approve',expectedSubmissionRevision:2},deps);
    const approved=await getMissionReviewDossier(db,input.missionKey,input.playerId);
    assert.deepEqual(approved.reviews.map(x=>x.decision),['return','approve']);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_mission_payout_receipts')).n,1);
});
test('HTTP exige versão explícita e protege dossiê de outro participante', async t=>{
    const db=await fixture();
    t.after(()=>db.close());
    const {handleMissionLifecycleHttp}=require('../helpers/clover/playerMissionLifecycleHttp');
    await readyToReview(db);
    const send=async({path,who='player-a',method='GET',payload,capabilities=[]})=>{
        let answer;
        const req={url:path,method,headers:{authorization:'Bearer fixture'},async *[Symbol.asyncIterator](){if(payload!==undefined)yield Buffer.from(JSON.stringify(payload))}};
        const res={statusCode:200,setHeader(){},end(value){answer=value?JSON.parse(value):null;}};
        await handleMissionLifecycleHttp(req,res,{getDb:()=>db,authenticateSession:async()=>({ok:true,player:{id:who}}),
            accessResolver:async()=>({ok:true,actor:{id:who,capabilities}})});
        return {status:res.statusCode,body:answer};
    };
    const p='/admin/mission-submissions/passe-fronteira/player-a';
    assert.equal((await send({path:p,who:'player-b'})).status,403);
    assert.equal((await send({path:p,who:'adm-1',capabilities:['mission.manage']})).body.dossier.contract.title,'Ecos na fronteira');
    assert.equal((await send({path:'/missions/passe-fronteira/record',who:'player-b'})).status,404);
    assert.equal((await send({path:'/missions/me/history'})).body.total,1);
    const req={path:p+'/review',who:'adm-1',method:'POST',capabilities:['mission.manage']};
    assert.equal((await send({...req,payload:{decision:'reject',reason:'Evidências insuficientes'}})).body.error,'mission_review_revision_required');
    assert.equal((await send({...req,payload:{decision:'reject',reason:'Evidências insuficientes',expectedSubmissionRevision:2}})).body.error,'mission_review_conflict');
    assert.equal((await send({...req,payload:{decision:'reject',reason:'Evidências insuficientes',expectedSubmissionRevision:1}})).body.participation.status,'rejected');
});

test('mesma referência de atuação não pode pagar por missões diferentes ou pela avaliação tradicional', async t=>{
    const db=await fixture({mode:'auto_narrated'});
    t.after(()=>db.close());
    const {findMissionSceneClaim,quotedSceneKey}=require('../helpers/clover/missionSceneClaims');
    const msg={message:{extendedTextMessage:{contextInfo:{stanzaId:'fictional-scene',participant:'fixture-player@lid'}}}};
    const scene=quotedSceneKey(msg,'fixture-group@g.us');
    assert.equal(scene,'fixture-group@g.us:fixture-player@lid:fictional-scene');
    await db.exec('CREATE TABLE clover_quick_evaluations (id INTEGER PRIMARY KEY,quoted_message_key TEXT)');
    await db.run('INSERT INTO clover_quick_evaluations(quoted_message_key) VALUES (?)',[scene]);
    const input={missionKey:'passe-fronteira',playerId:'player-a',sourceSceneKey:scene,
        text:'Investiguei a patrulha e apresentei as evidências.'};
    await joinMission(db,input);
    await assert.rejects(()=>submitMission(db,input),e=>e.code==='mission_scene_already_evaluated');
    assert.equal((await getMyMission(db,input.missionKey,input.playerId)).status,'in_progress');
    assert.equal(await findMissionSceneClaim(db,scene),null);
    await db.run('DELETE FROM clover_quick_evaluations');
    assert.equal((await submitMission(db,input)).duplicate,false);
    assert.equal((await submitMission(db,input)).duplicate,true);
    assert.equal((await findMissionSceneClaim(db,scene)).mission_key,input.missionKey);
    await joinMission(db,{...input,playerId:'player-b'});
    await assert.rejects(()=>submitMission(db,{...input,playerId:'player-b'}),e=>e.code==='mission_scene_already_claimed');
    // Simulate a conflicting imported traditional receipt; approval must fail closed.
    await db.run('INSERT INTO clover_quick_evaluations(quoted_message_key) VALUES (?)',[scene]);
    await assert.rejects(()=>reviewMission(db,{...input,actorId:'adm-1',decision:'approve'},deps),e=>e.code==='mission_scene_already_evaluated');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM clover_mission_payout_receipts')).n,0);
    await db.run('DELETE FROM clover_quick_evaluations');
    assert.equal((await reviewMission(db,{...input,actorId:'adm-1',decision:'approve'},deps)).participation.status,'approved');
    assert.ok(await findMissionSceneClaim(db,scene));
});
test('handler real de ficha tradicional recusa uma cena reservada antes de resolver alvo ou pagar',async t=>{
    const db=await fixture({mode:'auto_narrated'});
    t.after(()=>db.close());
    const Module=require('node:module');
    const path=require.resolve('../helpers/clover/quickEvaluationService');
    const replies=[];
    const message={key:{id:'fictional-evaluation'},message:{extendedTextMessage:{contextInfo:{stanzaId:'fixture-claimed',participant:'fixture-player@lid'}}}};
    const {quotedSceneKey}=require('../helpers/clover/missionSceneClaims');
    const chat='fixture-group@g.us';
    const input={missionKey:'passe-fronteira',playerId:'player-a',text:'Investiguei a patrulha, registrei o relatório e retornei.',sourceSceneKey:quotedSceneKey(message,chat)};
    await joinMission(db,input);
    await submitMission(db,input);
    delete require.cache[path];
    const original=Module._load;
    Module._load=function(request,parent,isMain){
        if(parent?.filename===path){
            if(request==='../chatReply')return {sendReply:async ({text})=>replies.push(text),sendReaction:async()=>{}};
            if(request==='./groupManager')return {isConfiguredCloverGroup:async()=>true};
            if(request==='./accessControlService')return {hasAccessPermission:async()=>true};
            if(request==='./targetResolver')return {resolveTargetPlayer:async()=>{throw new Error('unexpected target resolution')}};
        }
        return original.call(this,request,parent,isMain);
    };
    let service;
    try{service=require(path);}finally{Module._load=original;delete require.cache[path];}
    const text=['Ficha de Avaliacao','Pessoa: Jogador Teste','PH: 10','Yulls: 100','Tipo de treino: (x) Treino Solo'].join('\n');
    assert.equal(await service.tryHandleQuickEvaluation({sock:{},db,m:message,idChat:chat,evaluatorId:'fixture-adm@lid',text}),true);
    assert.match(replies[0],/pertence a uma missão registrada/);
    assert.equal((await db.get('SELECT reward_balance FROM jogadores WHERE id=?',['player-a'])).reward_balance,0);
});
