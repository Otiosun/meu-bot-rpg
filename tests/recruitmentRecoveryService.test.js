'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    findPendingReferralWithExistingUp,
    retryPendingReferralFromExistingUp,
} = require('../helpers/clover/recruitmentRecoveryService');

async function createDatabase() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            jogo_status TEXT,
            jogo_liberado_at TEXT
        );
        CREATE TABLE clover_recruitment_events (
            id INTEGER PRIMARY KEY,
            event_key TEXT NOT NULL
        );
        CREATE TABLE clover_recruitment_referrals (
            id INTEGER PRIMARY KEY,
            event_id INTEGER NOT NULL,
            recruit_player_id TEXT NOT NULL,
            recruiter_player_id TEXT NOT NULL,
            status TEXT NOT NULL
        );
        CREATE TABLE clover_quick_evaluations (
            id INTEGER PRIMARY KEY,
            player_id TEXT NOT NULL,
            scene_sent_at TEXT,
            created_at TEXT,
            modality_key TEXT DEFAULT 'treino_solo',
            metadata_json TEXT,
            rewards_json TEXT
        );
        INSERT INTO clover_recruitment_events (id, event_key)
        VALUES (1, 'divulgacao_v1');
    `);
    return db;
}

test('localiza apenas UP posterior à liberação do personagem', async (t) => {
    const db = await createDatabase();
    t.after(() => db.close());
    await db.run(
        `INSERT INTO jogadores VALUES ('novato', 'liberado', '2026-07-10 10:00:00')`
    );
    await db.run(
        `INSERT INTO clover_recruitment_referrals
         VALUES (1, 1, 'novato', 'recrutador', 'pending')`
    );
    await db.run(
        `INSERT INTO clover_quick_evaluations (id,player_id,scene_sent_at,created_at)
         VALUES (1, 'novato', '2026-07-09 12:00:00', '2026-07-09 12:00:00')`
    );

    const before = await findPendingReferralWithExistingUp(db, 'novato');
    assert.equal(before.recoverable, false);
    assert.equal(before.reason, 'waiting_first_up');

    await db.run(
        `INSERT INTO clover_quick_evaluations (id,player_id,scene_sent_at,created_at)
         VALUES (2, 'novato', '2026-07-11 12:00:00', '2026-07-11 12:00:00')`
    );
    const after = await findPendingReferralWithExistingUp(db, 'novato');
    assert.equal(after.recoverable, true);
    assert.equal(after.evaluation.id, 2);
});

test('repassa indicação e primeiro UP para entrega transacional', async (t) => {
    const db = await createDatabase();
    t.after(() => db.close());
    await db.run(
        `INSERT INTO jogadores VALUES ('novato', 'liberado', '2026-07-10 10:00:00')`
    );
    await db.run(
        `INSERT INTO clover_recruitment_referrals
         VALUES (7, 1, 'novato', 'recrutador', 'pending')`
    );
    await db.run(
        `INSERT INTO clover_quick_evaluations (id,player_id,scene_sent_at,created_at)
         VALUES (9, 'novato', '2026-07-11 12:00:00', '2026-07-11 12:00:00')`
    );

    let deliveryCalls = 0;
    const result = await retryPendingReferralFromExistingUp(db, 'novato', {
        actorId: 'admin',
        deliver: async (_db, referral, evaluation, actorId) => {
            deliveryCalls += 1;
            assert.equal(referral.id, 7);
            assert.equal(evaluation.id, 9);
            assert.equal(actorId, 'admin');
            return { ok: true, duplicate: false, referral: { ...referral, status: 'rewarded' } };
        },
    });

    assert.equal(deliveryCalls, 1);
    assert.equal(result.validated, true);
    assert.equal(result.recovered, true);
});

test('serviço usa recuperação no painel e no reenvio do mesmo código', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'helpers', 'clover', 'recruitmentService.js'),
        'utf8'
    );

    const calls = source.match(/retryPendingReferralFromExistingUp\(/g) || [];
    assert.equal(calls.length, 2);
    assert.match(source, /return \{ ok: true, duplicate: true, referral: eligibility\.referral, validation \}/);
    assert.match(source, /recovery,/);
    assert.match(source, /deliver: deliverReferralRewards/);
});

test('primeiro UP ignora lançamentos administrativos, anulados e sem data verificável',async t=>{
    const db=await createDatabase();
    t.after(()=>db.close());
    await db.run("INSERT INTO jogadores VALUES('novato','liberado','2026-07-10 10:00:00')");
    await db.run("INSERT INTO clover_recruitment_referrals VALUES(1,1,'novato','recrutador','pending')");
    const insert=(id,date,modality,metadata,rewards)=>db.run("INSERT INTO clover_quick_evaluations VALUES(?,'novato',?,?,?,?,?)",[id,date,date,modality,metadata,rewards]);
    await insert(1,'2026-07-11 10:00:00','admin_weekly_ph','{}','{}');
    await insert(2,'2026-07-11 11:00:00','treino_solo','{"hidden_from_evaluation_feed":true}','{}');
    await insert(3,'2026-07-11 12:00:00','treino_solo','{"voided_by_correction":1}','{}');
    await insert(4,'2026-07-11 13:00:00','treino_solo','{}','{"cap":"anulado"}');
    await insert(5,'2026-07-11 14:00:00','treino_solo','broken-json','{}');
    await insert(6,'invalid','treino_solo','{}','{}');
    assert.equal((await findPendingReferralWithExistingUp(db,'novato')).recoverable,false);
    await insert(8,'2026-07-13 10:00:00','treino_solo','{}','{}');
    await insert(9,'2026-07-12 10:00:00','treino_solo','{}','{}');
    assert.equal((await findPendingReferralWithExistingUp(db,'novato')).evaluation.id,9);
    const {findEligibleFirstUp}=require('../helpers/clover/recruitmentUpEvidence');
    assert.ok(!await findEligibleFirstUp(db,'novato','2026-07-10 10:00:00',{evaluationId:1}));
    await db.run("UPDATE jogadores SET jogo_liberado_at=NULL WHERE id='novato'");
    assert.equal((await findPendingReferralWithExistingUp(db,'novato')).recoverable,false);
});
