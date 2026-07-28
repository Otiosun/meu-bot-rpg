'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
let createDb;
try {
    const sqlite3 = require('sqlite3').verbose();
    const { open } = require('sqlite');
    createDb = () => open({ filename: ':memory:', driver: sqlite3.Database });
} catch {
    const { DatabaseSync } = require('node:sqlite');
    Module._load = function loadForGroupTests(request, parent, isMain) {
        if (request === 'sqlite3') return { verbose: () => ({ Database: class TestDriver {} }) };
        if (request === 'sqlite') return { open: async () => { throw new Error('open() não deve ser usado'); } };
        return originalLoad.call(this, request, parent, isMain);
    };
    createDb = async () => {
        const raw = new DatabaseSync(':memory:');
        raw.exec('PRAGMA foreign_keys = ON');
        return {
            exec: async (sql) => raw.exec(sql),
            run: async (sql, params = []) => {
                const result = raw.prepare(sql).run(...params);
                return { changes: Number(result.changes || 0), lastID: Number(result.lastInsertRowid || 0) };
            },
            get: async (sql, params = []) => raw.prepare(sql).get(...params),
            all: async (sql, params = []) => raw.prepare(sql).all(...params),
            close: async () => raw.close(),
        };
    };
}

const { ensureCloverRecruitmentSchema } = require('../database');
const { adminAdjustPr, getPrBalance, getPrSummary } = require('../helpers/clover/prService');
const {
    RecruitmentGroupServiceError,
    getGroupPromotionDashboard,
    recordGroupPromotion,
    settleGroupPromotionCarryover,
} = require('../helpers/clover/recruitmentGroupService');
const {
    parseGroupReport,
    renderGroupGrant,
    validateApprovalContext,
} = require('../comandos/pr');

Module._load = originalLoad;

async function setup() {
    const db = await createDb();
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT DEFAULT '-',
            jogo_status TEXT DEFAULT 'liberado'
        );
        INSERT INTO jogadores (id, personagem_nome) VALUES ('p1', 'Divulgador');
        INSERT INTO jogadores (id, personagem_nome) VALUES ('admin', 'Admin');
    `);
    await ensureCloverRecruitmentSchema(db);
    await db.run(
        `UPDATE clover_recruitment_events
         SET status = 'active', starts_at = '2026-07-20 00:00:00', ends_at = '2026-08-20 00:00:00',
             group_weekly_pr_limit = 20
         WHERE event_key = 'divulgacao_v1'`
    );
    return db;
}

function options(key, weekKey = '2026-07-20') {
    return {
        weekKey,
        at: new Date('2026-07-21T12:00:00-03:00'),
        idempotencyKey: key,
        relatedId: `test:${key}`,
        metadata: { test: true },
    };
}

test('converte grupos em 0,4 PR e preserva todo excedente acima de 50', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    const first = await recordGroupPromotion(db, 'p1', 12, 'Primeiro lote', 'admin', options('groups:1'));
    assert.equal(first.submission.groups_reported, 12);
    assert.equal(first.submission.groups_credited, 12);
    assert.equal(first.submission.groups_excess, 0);
    assert.equal(first.submission.pr_awarded, 4.8);

    const second = await recordGroupPromotion(db, 'p1', 60, 'Segundo lote', 'admin', options('groups:2'));
    assert.equal(second.submission.groups_reported, 60);
    assert.equal(second.submission.groups_credited, 38);
    assert.equal(second.submission.groups_excess, 22);
    assert.equal(second.submission.pr_awarded, 15.2);

    const third = await recordGroupPromotion(db, 'p1', 10, 'Acima do teto', 'admin', options('groups:3'));
    assert.equal(third.submission.groups_credited, 0);
    assert.equal(third.submission.groups_excess, 10);
    assert.equal(third.submission.pr_awarded, 0);

    const dashboard = await getGroupPromotionDashboard(db, 'p1', options('dashboard'));
    assert.equal(dashboard.groupsReported, 82);
    assert.equal(dashboard.groupsCredited, 50);
    assert.equal(dashboard.groupsExcess, 32);
    assert.equal(dashboard.prEarned, 20);
    assert.equal(dashboard.prRemaining, 0);
    assert.equal(await getPrBalance(db, 'p1'), 20);

    const ledger = await db.all(
        `SELECT amount, typeof(amount) AS storage_type
         FROM clover_pr_ledger WHERE source = 'divulgacao_grupo' ORDER BY id`
    );
    assert.deepEqual(ledger.map((row) => Number(row.amount)), [4.8, 15.2]);
    assert.equal(ledger.every((row) => row.storage_type === 'real'), true);
});

test('repetir a mesma mensagem não duplica grupos nem PR', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    const first = await recordGroupPromotion(db, 'p1', 25, 'Lote', 'admin', options('groups:duplicate'));
    const duplicate = await recordGroupPromotion(db, 'p1', 25, 'Lote', 'admin', options('groups:duplicate'));

    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_recruitment_group_submissions')).total, 1);
    assert.equal((await db.get("SELECT COUNT(*) AS total FROM clover_pr_ledger WHERE source = 'divulgacao_grupo'")).total, 1);
    assert.equal(await getPrBalance(db, 'p1'), 10);
});

test('nova semana reabre o teto de 50 grupos', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    await recordGroupPromotion(db, 'p1', 50, 'Semana um', 'admin', options('groups:w1', '2026-07-20'));
    await recordGroupPromotion(db, 'p1', 50, 'Semana dois', 'admin', options('groups:w2', '2026-07-27'));

    const weekTwo = await getGroupPromotionDashboard(db, 'p1', { weekKey: '2026-07-27' });
    assert.equal(weekTwo.groupsCredited, 50);
    assert.equal(weekTwo.prEarned, 20);
    assert.equal(await getPrBalance(db, 'p1'), 40);
});

test('nova semana reaproveita excedente antigo automaticamente uma vez', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    await recordGroupPromotion(db, 'p1', 600, 'Semana um', 'admin', options('groups:large', '2026-07-20'));
    const carryover = await settleGroupPromotionCarryover(db, 'p1', options('carryover:w2', '2026-07-27'));
    const duplicate = await settleGroupPromotionCarryover(db, 'p1', options('carryover:w2-again', '2026-07-27'));

    assert.equal(carryover.duplicate, false);
    assert.equal(carryover.submission.groups_reported, 50);
    assert.equal(carryover.submission.groups_credited, 50);
    assert.equal(carryover.submission.groups_excess, 0);
    assert.equal(duplicate.duplicate, true);

    const previous = await getGroupPromotionDashboard(db, 'p1', { weekKey: '2026-07-20' });
    const current = await getGroupPromotionDashboard(db, 'p1', { weekKey: '2026-07-27' });
    assert.equal(previous.groupsExcess, 500);
    assert.equal(current.groupsCredited, 50);
    assert.equal(current.prEarned, 20);
    assert.equal(await getPrBalance(db, 'p1'), 40);
});

test('ajuste manual de PR fica fora do teto semanal de grupos', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    await recordGroupPromotion(db, 'p1', 50, 'Semana cheia', 'admin', options('groups:cap'));
    const result = await adminAdjustPr(db, 'p1', 30, 'Avalia��o do site', 'admin', {
        source: 'ajuste_admin',
        weekKey: '2026-07-20',
        idempotencyKey: 'manual:site-review:1',
    });

    assert.equal(result.amount, 30);
    assert.equal(result.source, 'ajuste_admin');
    const summary = await getPrSummary(db, 'p1', { weekKey: '2026-07-20' });
    assert.equal(summary.groupWeekEarned, 20);
    assert.equal(summary.balance, 50);
});
test('evento inativo impede lançamento antes de qualquer escrita', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    await db.run("UPDATE clover_recruitment_events SET status = 'paused'");

    await assert.rejects(
        () => recordGroupPromotion(db, 'p1', 10, 'Pausado', 'admin', options('groups:paused')),
        (error) => error instanceof RecruitmentGroupServiceError && error.code === 'event_not_active'
    );
    assert.equal((await db.get("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'clover_recruitment_group_submissions'")).total, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_recruitment_group_submissions')).total, 0);
});

test('parser aceita menção, resposta, nome e forma dar grupos', () => {
    assert.deepEqual(
        parseGroupReport('grupos 37 @p1 comprovante enviado', { mentionedJid: ['p1'] }),
        {
            groupReport: true,
            groups: 37,
            reason: 'comprovante enviado',
            targetId: 'p1',
            targetText: null,
            quotedParticipant: null,
            reasonStart: 3,
        }
    );
    const reply = parseGroupReport('grupos 8 prova', { participant: 'p1' });
    assert.equal(reply.targetId, 'p1');
    assert.equal(reply.reason, 'prova');
    const named = parseGroupReport('grupos 5 Divulgador prova');
    assert.equal(named.targetText, 'Divulgador');
    assert.equal(named.reason, 'prova');
    const withDar = parseGroupReport('dar grupos 9 @p1', { mentionedJid: ['p1'] });
    assert.equal(withDar.groupReport, true);
    assert.equal(withDar.groups, 9);
    assert.equal(withDar.targetId, 'p1');
});

test('aprovação funciona em qualquer grupo para dona ou ADM local', async () => {
    const ownerResult = await validateApprovalContext({
        sock: { groupMetadata: async () => { throw new Error('não deveria consultar'); } },
        idChat: 'qualquer-grupo@g.us',
        idJogador: '557998868223@s.whatsapp.net',
    });
    assert.equal(ownerResult, null);

    const adminResult = await validateApprovalContext({
        sock: { groupMetadata: async () => ({ participants: [{ id: 'admin@s.whatsapp.net', admin: 'admin' }] }) },
        idChat: 'outro-grupo@g.us',
        idJogador: 'admin@s.whatsapp.net',
    });
    assert.equal(adminResult, null);

    const denied = await validateApprovalContext({
        sock: { groupMetadata: async () => ({ participants: [{ id: 'player@s.whatsapp.net', admin: null }] }) },
        idChat: 'outro-grupo@g.us',
        idJogador: 'player@s.whatsapp.net',
    });
    assert.match(denied, /ADM/);

    const privateChat = await validateApprovalContext({
        sock: {},
        idChat: 'player@s.whatsapp.net',
        idJogador: '557998868223@s.whatsapp.net',
    });
    assert.equal(privateChat, 'Use esse comando em um grupo.');
});

test('feedback de grupos é curto e mostra crédito, excedente e saldo', () => {
    const text = renderGroupGrant({
        duplicate: false,
        submission: {
            groups_reported: 64,
            groups_credited: 50,
            groups_excess: 14,
            pr_awarded: 20,
        },
        summary: { balance: 27.2 },
    }, { id: 'p1@s.whatsapp.net' });

    assert.equal(text, '✅ @p1: 64 grupos registrados · +20 PR · 14 excedentes salvos · saldo 27,2 PR.');
    assert.equal(text.split('\n').length, 1);
});
