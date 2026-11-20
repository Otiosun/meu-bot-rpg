'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { auditRecruitmentFlow } = require('../helpers/clover/recruitmentFlowAudit');

async function createDatabase() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome TEXT,
            display_name TEXT,
            ficha_status TEXT,
            personagem_aparencia_status TEXT,
            jogo_status TEXT,
            jogo_liberado_at TEXT
        );
        CREATE TABLE clover_recruitment_events (
            id INTEGER PRIMARY KEY,
            event_key TEXT,
            name TEXT,
            status TEXT,
            starts_at TEXT,
            ends_at TEXT,
            referral_window_days INTEGER,
            recruiter_pr_reward INTEGER,
            group_weekly_pr_limit INTEGER,
            recruit_yulls_reward INTEGER,
            recruit_ph_reward INTEGER,
            recruit_item_quantity INTEGER,
            shop_enabled INTEGER
        );
        CREATE TABLE clover_recruitment_codes (
            id INTEGER PRIMARY KEY,
            player_id TEXT,
            code TEXT,
            active INTEGER
        );
        CREATE TABLE clover_recruitment_referrals (
            id INTEGER PRIMARY KEY,
            event_id INTEGER,
            recruit_player_id TEXT,
            recruiter_player_id TEXT,
            recruitment_code TEXT,
            status TEXT,
            submitted_at TEXT,
            deadline_at TEXT,
            validation_evaluation_id INTEGER,
            validated_at TEXT,
            rewarded_at TEXT
        );
        CREATE TABLE clover_recruitment_reward_deliveries (
            id INTEGER PRIMARY KEY,
            referral_id INTEGER,
            status TEXT
        );
        CREATE TABLE clover_pr_ledger (
            id INTEGER PRIMARY KEY,
            player_id TEXT,
            event_id INTEGER,
            amount INTEGER,
            source TEXT,
            week_key TEXT,
            idempotency_key TEXT,
            metadata_json TEXT
        );
        CREATE TABLE clover_quick_evaluations (
            id INTEGER PRIMARY KEY,
            player_id TEXT,
            scene_sent_at TEXT,
            created_at TEXT,
            modality_key TEXT DEFAULT 'treino_solo',
            metadata_json TEXT,
            rewards_json TEXT
        );
        CREATE TABLE clover_yulls_ledger (
            id INTEGER PRIMARY KEY,
            idempotency_key TEXT
        );
        CREATE TABLE clover_ph_ledger (
            id INTEGER PRIMARY KEY,
            related_id TEXT
        );
        CREATE TABLE clover_inventory_items (
            id INTEGER PRIMARY KEY,
            player_id TEXT,
            source TEXT,
            related_id TEXT
        );
    `);
    await db.run(
        `INSERT INTO clover_recruitment_events
         VALUES (1, 'divulgacao_v1', 'Evento de Divulgação', 'active',
                 '2026-07-01 00:00:00', '2026-08-01 00:00:00', 7, 5, 20, 10000, 30, 1, 0)`
    );
    return db;
}

test('detecta indicação pendente que já possui primeiro UP', async () => {
    const db = await createDatabase();
    try {
        await db.run(
            `INSERT INTO jogadores VALUES
             ('recruiter', 'Recrutador', NULL, NULL, 'aprovada', 'approved', 'liberado', '2026-07-01 10:00:00'),
             ('recruit', 'Novato', NULL, NULL, 'aprovada', 'approved', 'liberado', '2026-07-10 10:00:00')`
        );
        await db.run(`INSERT INTO clover_recruitment_codes VALUES (1, 'recruiter', 'CV-ABC234', 1)`);
        await db.run(
            `INSERT INTO clover_recruitment_referrals
             VALUES (1, 1, 'recruit', 'recruiter', 'CV-ABC234', 'pending',
                     '2026-07-10 11:00:00', '2026-07-17 10:00:00', NULL, NULL, NULL)`
        );
        await db.run(
            `INSERT INTO clover_quick_evaluations(id,player_id,scene_sent_at,created_at)
             VALUES (7, 'recruit', '2026-07-11 12:00:00', '2026-07-11 12:05:00')`
        );

        const report = await auditRecruitmentFlow(db, { at: new Date('2026-07-12T12:00:00') });
        assert.equal(report.summary.referrals, 1);
        assert.ok(report.issues.some((item) => item.code === 'pending_referral_with_up'));
    } finally {
        await db.close();
    }
});

test('expõe que o schema atual não suporta 0,4 PR nem preserva grupos excedentes', async () => {
    const db = await createDatabase();
    try {
        const report = await auditRecruitmentFlow(db, { at: new Date('2026-07-12T12:00:00') });
        assert.equal(report.capabilities.fractionalPrStoredNatively, false);
        assert.equal(report.capabilities.groupCountStoredSeparately, false);
        assert.ok(report.issues.some((item) => item.code === 'fractional_pr_unsupported'));
        assert.ok(report.issues.some((item) => item.code === 'group_count_not_persisted'));
    } finally {
        await db.close();
    }
});

test('recompensa completa não gera falso positivo de entrega', async () => {
    const db = await createDatabase();
    try {
        await db.run(
            `INSERT INTO jogadores VALUES
             ('recruiter', 'Recrutador', NULL, NULL, 'aprovada', 'approved', 'liberado', '2026-07-01 10:00:00'),
             ('recruit', 'Novato', NULL, NULL, 'aprovada', 'approved', 'liberado', '2026-07-10 10:00:00')`
        );
        await db.run(
            `INSERT INTO clover_recruitment_referrals
             VALUES (2, 1, 'recruit', 'recruiter', 'CV-ABC234', 'rewarded',
                     '2026-07-10 11:00:00', '2026-07-17 10:00:00', 8,
                     '2026-07-11 12:00:00', '2026-07-11 12:00:01')`
        );
        await db.run(`INSERT INTO clover_recruitment_reward_deliveries VALUES (1, 2, 'completed')`);
        await db.run(
            `INSERT INTO clover_pr_ledger
             VALUES (1, 'recruiter', 1, 5, 'recrutamento', '2026-07-07',
                     'pr:recruitment:referral:2', NULL)`
        );
        await db.run(`INSERT INTO clover_yulls_ledger VALUES (1, 'yulls:recruitment:referral:2')`);
        await db.run(`INSERT INTO clover_ph_ledger VALUES (1, 'recruitment_referral:2')`);
        await db.run(`INSERT INTO clover_inventory_items VALUES (1, 'recruit', 'recrutamento', 'recruitment_referral:2')`);

        const report = await auditRecruitmentFlow(db, { at: new Date('2026-07-12T12:00:00') });
        const rewardIssues = report.issues.filter((item) => item.code.startsWith('rewarded_without_'));
        assert.deepEqual(rewardIssues, []);
    } finally {
        await db.close();
    }
});

test('auditoria ignora falso UP administrativo e escolhe atividade posterior à liberação por data',async t=>{
    const db=await createDatabase();t.after(()=>db.close());
    await db.run("INSERT INTO jogadores VALUES('recruit','Novato',NULL,NULL,'aprovada','approved','liberado','2026-07-10 10:00:00'),('recruiter','Recrutador',NULL,NULL,'aprovada','approved','liberado','2026-07-01 10:00:00')");
    await db.run("INSERT INTO clover_recruitment_referrals VALUES(1,1,'recruit','recruiter','CV-ABC234','pending','2026-07-10 11:00:00','2026-07-17 10:00:00',NULL,NULL,NULL)");
    await db.run("INSERT INTO clover_quick_evaluations VALUES(1,'recruit','2026-07-11 10:00:00','2026-07-11 10:00:00','admin_weekly_ph','{}','{}'),(2,'recruit','2026-07-09 10:00:00','2026-07-12 10:00:00','treino_solo','{}','{}')");
    await db.exec('PRAGMA query_only=ON');
    const first=await auditRecruitmentFlow(db,{at:new Date('2026-07-12T12:00:00Z')});
    assert.equal(first.referrals[0].firstEvaluationId,null);
    assert.ok(!first.issues.some(x=>x.code==='pending_referral_with_up'));
    await db.exec('PRAGMA query_only=OFF');
    await db.run("INSERT INTO clover_quick_evaluations VALUES(3,'recruit','2026-07-12 10:00:00','2026-07-12 10:00:00','treino_solo','{}','{}'),(4,'recruit','2026-07-11 12:00:00','2026-07-12 10:00:00','treino_solo','{}','{}')");
    await db.exec('PRAGMA query_only=ON');
    const after=await auditRecruitmentFlow(db,{at:new Date('2026-07-12T12:00:00Z')});
    assert.equal(after.referrals[0].firstEvaluationId,4);
    assert.equal(after.issues.find(x=>x.code==='pending_referral_with_up').evaluationId,4);
});
