'use strict';

// Disposable new-season test. Never opens ./banco.sqlite or imports a player dump.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarBanco } = require('../database');
const { CURRENT_SCHEMA_MIGRATIONS } = require('../helpers/clover/schemaMigrationCatalog');
const { inspectCloverMigrationState } = require('../helpers/clover/schemaMigrationService');
const { ensureMissionParticipationSchema, joinMission, submitMission, reviewMission,
    getMyMission, listMyMissions } = require('../helpers/clover/playerMissionLifecycleService');
const { getPhSummary } = require('../helpers/clover/phService');
const { getYullsSummary } = require('../helpers/clover/yullsService');

test('nova temporada: bootstrap real sem jogadores antigos, recompensas persistidas e replay após reinício', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-new-season-'));
    const filename = path.join(dir, 'season.sqlite');
    let db;
    t.after(async () => {
        if (db) await db.close().catch(() => {});
        fs.rmSync(dir, { recursive: true, force: true });
    });
    db = await criarBanco({ filename });
    const count = async table => (await db.get('SELECT COUNT(*) AS n FROM ' + table)).n;
    for (const table of ['jogadores','player_progress','player_onboarding','player_rolls','clover_quick_evaluations']) {
        assert.equal(await count(table), 0, table);
    }
    const migration = await inspectCloverMigrationState(db, { migrations: CURRENT_SCHEMA_MIGRATIONS });
    assert.equal(migration.userVersion, CURRENT_SCHEMA_MIGRATIONS.at(-1).version);
    assert.equal(migration.applied.length, CURRENT_SCHEMA_MIGRATIONS.length);
    assert.equal(migration.schemaFingerprintMatchesLatest, true);
    assert.equal(Object.values(await db.get('PRAGMA integrity_check'))[0], 'ok');
    assert.deepEqual(await db.all('PRAGMA foreign_key_check'), []);
    assert.equal(Object.values(await db.get('PRAGMA foreign_keys'))[0], 1);

    // All values below are fictional, scoped to this temporary database.
    const input = { missionKey: 'laboratorio-temporada', playerId: 'season-test-player' };
    await db.run('INSERT INTO jogadores (id, nome, personagem_nome, ficha_status, jogo_status) VALUES (?, ?, ?, \'aprovada\', \'liberado\')',
        [input.playerId, 'Jogador de teste', 'Cavaleiro de teste']);
    await ensureMissionParticipationSchema(db);
    assert.equal(await count('clover_missions'), 0);
    assert.equal(await count('clover_mission_participations'), 0);
    await db.run(
        "INSERT INTO clover_missions (mission_key,status,revision,title,rank,mode,location,mission_type,risk,slots,deadline_at,reward_json,description,metadata_json) VALUES (?,'published',2,?,'D','auto_narrated','Capital','investigation','Baixo',2,?,?,?,'{}')",
        [input.missionKey, 'Patrulha de laboratório', new Date(Date.now()+86400000).toISOString(),
            JSON.stringify({ph:[10,10],yulls:[900,900],stars:[0,0]}), 'Investigue a patrulha.']
    );
    const ph = (await getPhSummary(db,input.playerId)).phAvailable;
    const yulls = (await getYullsSummary(db,input.playerId)).balance;
    assert.equal((await joinMission(db,input)).participation.status,'in_progress');
    await submitMission(db,{...input,text:'Investiguei o caminho e documentei as evidências da patrulha.'});
    const review = {...input,actorId:'season-test-adm',decision:'approve'};
    const first = await reviewMission(db,review);
    assert.equal(first.duplicate,false);
    assert.equal(await count('clover_mission_payout_receipts'),1);
    const {getServiceSummary}=require('../helpers/clover/adminService');
    assert.equal((await getServiceSummary(db,review.actorId)).pendingPoints,2);
    assert.equal(await count('clover_mission_service_links'),1);
    assert.equal(await count('clover_quick_evaluations'),0);
    await db.close();
    db = null;
    db = await criarBanco({filename});
    assert.equal((await getMyMission(db,input.missionKey,input.playerId)).status,'approved');
    assert.equal((await listMyMissions(db,input.playerId)).total,1);
    assert.equal((await reviewMission(db,review)).duplicate,true);
    assert.equal((await getPhSummary(db,input.playerId)).phAvailable,ph+10);
    assert.equal((await getYullsSummary(db,input.playerId)).balance,yulls+900);
    assert.equal(await count('clover_mission_payout_receipts'),1);
    assert.equal(await count('jogadores'),1);
    assert.equal((await getServiceSummary(db,review.actorId)).pendingPoints,2);
    assert.equal(await count('clover_mission_service_links'),1);
    assert.equal(Object.values(await db.get('PRAGMA integrity_check'))[0],'ok');
    assert.deepEqual(await db.all('PRAGMA foreign_key_check'),[]);
});

test('regra aprovada: contrato oficial de rank A paga 60 PH mesmo com teto comum cheio',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clover-mission-ph-policy-'));
    let db;
    t.after(async()=>{try{if(db)await db.close();}finally{fs.rmSync(dir,{recursive:true,force:true});}});
    db=await criarBanco({filename:path.join(dir,'season.sqlite')});
    const playerId='policy-lab-player',missionKey='policy-lab-patrulha',actorId='policy-lab-reviewer';
    await db.run("INSERT INTO jogadores(id,nome,personagem_nome,ficha_status,jogo_status) VALUES(?,?,?,'aprovada','liberado')",[playerId,'Teste','Cavaleiro de teste']);
    await ensureMissionParticipationSchema(db);
    const {resolveEffectiveDate,getWeeklyPhCapSummary,recordWeeklyPhUsageInTransaction}=require('../helpers/clover/weeklyPhCapService');
    const {addPhInTransaction}=require('../helpers/clover/phService');
    const {startMission}=require('../helpers/clover/playerMissionLifecycleService');
    const date=resolveEffectiveDate(new Date());
    const initial=(await getPhSummary(db,playerId)).phAvailable;
    await db.exec('BEGIN IMMEDIATE');
    try{
        await recordWeeklyPhUsageInTransaction(db,{usageKey:'policy-full-common',playerId,weekKey:date.weekKey,effectiveDate:date.localDate,requestedAmount:30,appliedAmount:30,createdBy:actorId});
        await addPhInTransaction(db,playerId,30,'admin_weekly_ph','Fixture do teto comum',actorId,{},'policy-full-common');
        await db.exec('COMMIT');
    }catch(error){await db.exec('ROLLBACK');throw error;}
    assert.equal((await getWeeklyPhCapSummary(db,playerId,date.localDate)).remaining,0);
    await db.run("INSERT INTO clover_missions(mission_key,status,revision,title,rank,mode,location,mission_type,risk,slots,deadline_at,reward_json,description,metadata_json) VALUES(?,'published',1,'Patrulha','A','official','Capital','investigation','Alto',2,?,?,?,'{}')",[missionKey,new Date(Date.now()+86400000).toISOString(),JSON.stringify({ph:[60,60],yulls:[4500,4500],stars:[3,3]}),'Investigue os registros da fronteira.']);
    const input={missionKey,playerId};
    await joinMission(db,input);await startMission(db,input);
    await submitMission(db,{...input,text:'Investiguei a fronteira, reuni provas e retornei com testemunhas.'});
    const result=await reviewMission(db,{...input,actorId,decision:'approve'});
    assert.equal(result.receipt.reward.ph,60);
    assert.equal((await getPhSummary(db,playerId)).phAvailable,initial+90);
    assert.equal((await getWeeklyPhCapSummary(db,playerId,date.localDate)).used,30);
    const ledger=await db.get("SELECT * FROM clover_ph_ledger WHERE player_id=? AND source='clover_mission'",[playerId]);
    assert.equal(ledger.amount,60);
    assert.equal(JSON.parse(ledger.metadata_json).outside_weekly_limit,true);
    assert.equal(JSON.parse(ledger.metadata_json).ph_policy,'contract_outside_common_cap_v1');
    assert.equal((await reviewMission(db,{...input,actorId,decision:'approve'})).duplicate,true);
    assert.equal((await getPhSummary(db,playerId)).phAvailable,initial+90);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM clover_quick_evaluations WHERE player_id=?",[playerId])).n,1);
});
