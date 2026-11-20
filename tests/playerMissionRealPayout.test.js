'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    ensureMissionParticipationSchema, joinMission, startMission,
    submitMission, reviewMission,
} = require('../helpers/clover/playerMissionLifecycleService');
const { getPhSummary } = require('../helpers/clover/phService');
const { getYullsSummary } = require('../helpers/clover/yullsService');

async function realFixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`CREATE TABLE jogadores (
        id TEXT PRIMARY KEY,
        nome TEXT DEFAULT '-',
        display_name TEXT DEFAULT '-',
        personagem_nome TEXT DEFAULT '-',
        personagem_idade INTEGER DEFAULT NULL,
        personagem_genero TEXT DEFAULT '-',
        personagem_aparencia TEXT DEFAULT '-',
        personagem_aparencia_status TEXT DEFAULT 'approved',
        personagem_aparencia_image_path TEXT DEFAULT NULL,
        site_profile_image_data TEXT DEFAULT NULL,
        reino TEXT DEFAULT 'Clover', classe TEXT DEFAULT '-', familia TEXT DEFAULT '-',
        raca TEXT DEFAULT 'Humano', grimorio TEXT DEFAULT '-', magia TEXT DEFAULT '-',
        formas TEXT DEFAULT '-', esquadrao TEXT DEFAULT '',
        estrelas INTEGER DEFAULT 0, patente TEXT DEFAULT '-', aptidao_comum TEXT DEFAULT '-',
        aptidao_rara TEXT DEFAULT '-', marca_comum TEXT DEFAULT '-', marca_rara TEXT DEFAULT '-',
        anomalia TEXT DEFAULT '-', gancho_narrativo TEXT DEFAULT '-', historias_extras TEXT DEFAULT '[]',
        jogo_status TEXT DEFAULT 'liberado', dinheiro INTEGER DEFAULT 0
    );
    INSERT INTO jogadores (id, personagem_nome, esquadrao) VALUES
      ('mission-e2e-player', 'Explorador R25', 'Coringas Magenta');
    `);
    await ensureMissionParticipationSchema(db);
    const future = new Date(Date.now() + 86400000).toISOString();
    await db.run(`INSERT INTO clover_missions
        (mission_key, status, revision, title, rank, mode, location, mission_type,
         risk, slots, deadline_at, reward_json, description, metadata_json)
         VALUES (?, 'published', 2, ?, 'D', 'official', ?, 'investigation', ?, 2, ?, ?, ?, '{}')`,
    ['missao-real-01', 'Ecos da passagem', 'Fronteira', 'Risco controlado', future,
     JSON.stringify({ ph: [10, 10], yulls: [1000, 1000], stars: [1, 1] }),
     'Investigar a patrulha e retornar com provas.']);
    return db;
}
test('R25 paga PH, Yulls e Estrelas reais do jogador e esquadrão em um único recibo', async (t) => {
    const db = await realFixture();
    t.after(() => db.close());
    const input = { missionKey: 'missao-real-01', playerId: 'mission-e2e-player' };
    await db.run('INSERT INTO jogadores (id,personagem_nome) VALUES (?,?)',['mission-e2e-admin','Avaliador de teste']);
    const phBefore = (await getPhSummary(db, input.playerId)).phAvailable;
    const moneyBefore = (await getYullsSummary(db, input.playerId)).balance;
    await joinMission(db, input);
    await startMission(db, input);
    await submitMission(db, { ...input, text: 'Patrulhei toda a fronteira e entreguei os registros solicitados.' });
    const first = await reviewMission(db, { ...input, actorId: 'mission-e2e-admin', decision: 'approve' });
    assert.equal(first.duplicate, false);
    assert.equal(first.participation.status, 'approved');
    assert.equal((await getPhSummary(db, input.playerId)).phAvailable, phBefore + 10);
    assert.equal((await getYullsSummary(db, input.playerId)).balance, moneyBefore + 1000);
    assert.equal((await db.get('SELECT estrelas FROM jogadores WHERE id=?', [input.playerId])).estrelas, 1);
    const receipts = await db.get('SELECT * FROM clover_mission_payout_receipts WHERE mission_key=? AND player_id=?',
        [input.missionKey, input.playerId]);
    assert.ok(receipts.ph_ledger_id);
    assert.ok(receipts.yulls_ledger_id);
    assert.ok(receipts.stars_transaction_id);
    const starRow = await db.get('SELECT * FROM clover_player_star_reward_transactions WHERE id=?',
        [receipts.stars_transaction_id]);
    assert.equal(starRow.amount, 1);
    assert.equal(starRow.squad_key, 'coringas_magenta');
    const replay = await reviewMission(db, { ...input, actorId: 'mission-e2e-admin', decision: 'approve' });
    assert.equal(replay.duplicate, true);
    assert.equal((await getPhSummary(db, input.playerId)).phAvailable, phBefore + 10);
    assert.equal((await getYullsSummary(db, input.playerId)).balance, moneyBefore + 1000);
    assert.equal((await db.get('SELECT estrelas FROM jogadores WHERE id=?', [input.playerId])).estrelas, 1);
    const {getPaOriginSummary,purchasePhBySceneWeek}=require('../helpers/clover/paSceneWeekService');
    const evaluator='mission-e2e-admin';
    const summary=await getPaOriginSummary(db,evaluator,evaluator);
    assert.equal(summary.pendingPa,8);
    assert.equal(summary.purchasablePh,8);
    const before=(await getPhSummary(db,evaluator)).phAvailable;
    const purchase=await purchasePhBySceneWeek(db,evaluator,{quantity:3,idempotencyKey:'fixture-mission-pa-purchase'});
    assert.equal(purchase.ok,true);
    assert.equal(purchase.quantity,3);
    assert.equal((await getPaOriginSummary(db,evaluator,evaluator)).pendingPa,5);
    assert.equal((await getPhSummary(db,evaluator)).phAvailable,before+3);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM clover_mission_service_links")).n,1);
});
