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
    await db.run('INSERT INTO jogadores (id, nome, personagem_nome) VALUES (?, ?, ?)',
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
