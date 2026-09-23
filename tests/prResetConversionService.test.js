'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    ensureCloverAdminServiceSchema,
    ensureCloverCharacterStatsSchema,
    ensureCloverPhLedgerSchema,
    ensureCloverQuickEvaluationsSchema,
    ensureCloverRecruitmentSchema,
} = require('../database');
const {
    applyPrResetConversion,
    previewPrResetConversion,
} = require('../helpers/clover/prResetConversionService');

async function setup() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            dinheiro INTEGER DEFAULT 0,
            jogo_status TEXT DEFAULT 'liberado',
            is_shadow INTEGER DEFAULT 0,
            is_test_user INTEGER DEFAULT 0,
            character_kind TEXT DEFAULT 'player'
        );
    `);
    await db.run(
        `INSERT INTO jogadores (id, personagem_nome, jogo_status)
         VALUES ('player@lid', 'Player Um', 'liberado')`
    );
    await db.run(
        `INSERT INTO jogadores (id, personagem_nome, jogo_status, is_test_user, character_kind)
         VALUES ('ghost@lid', 'Whatever', 'liberado', 1, 'ghost')`
    );
    await ensureCloverCharacterStatsSchema(db);
    await ensureCloverPhLedgerSchema(db);
    await ensureCloverQuickEvaluationsSchema(db);
    await ensureCloverAdminServiceSchema(db);
    await ensureCloverRecruitmentSchema(db);
    return db;
}

async function addPhState(db, playerId, accumulated, available) {
    await db.run(
        `INSERT INTO clover_character_stats
         (player_id, stage_key, pb_total, pb_spent, ph_accumulated, ph_available)
         VALUES (?, '9', 0, 0, ?, ?)`,
        [playerId, accumulated, available]
    );
    await db.run(
        `INSERT INTO clover_ph_ledger
         (player_id, amount, kind, source, reason, related_id, created_by)
         VALUES (?, ?, 'ganho', 'teste', 'PH de teste', ?, 'test')`,
        [playerId, accumulated, `seed:${playerId}`]
    );
    if (accumulated > available) {
        await db.run(
            `INSERT INTO clover_ph_ledger
             (player_id, amount, kind, source, reason, related_id, created_by)
             VALUES (?, ?, 'gasto', 'teste', 'PH gasto', ?, 'test')`,
            [playerId, -(accumulated - available), `spent:${playerId}`]
        );
    }
}

async function addPendingPa(db, playerId, points) {
    await db.run(
        `INSERT INTO clover_admin_service_entries
         (evaluator_id, target_player_id, modality_key, modality_label, weight,
          points, paid_points, status, service_week_key, scene_week_key, created_by)
         VALUES (?, 'target@lid', 'teste', 'Teste', 1, ?, 0, 'pending',
                 '2026-08-24', '2026-08-24', 'test')`,
        [playerId, points]
    );
}

test('preview soma PH acumulado e PA pendente como PR sem incluir personagens de teste', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    await addPhState(db, 'player@lid', 120, 45);
    await addPendingPa(db, 'player@lid', 8);
    await addPhState(db, 'ghost@lid', 4000, 800);
    await addPendingPa(db, 'ghost@lid', 200);

    const preview = await previewPrResetConversion(db, { conversionKey: 'reset_pr_test' });

    assert.equal(preview.totals.players, 1);
    assert.equal(preview.totals.ph, 120);
    assert.equal(preview.totals.pa, 8);
    assert.equal(preview.totals.pr, 128);
    assert.deepEqual(preview.players.map((row) => row.playerId), ['player@lid']);
});

test('apply credita PR, consome PH acumulado/disponivel e quita PA pendente uma vez', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    await addPhState(db, 'player@lid', 120, 45);
    await addPendingPa(db, 'player@lid', 8);

    const first = await applyPrResetConversion(db, {
        conversionKey: 'reset_pr_apply',
        createdBy: 'owner@lid',
    });
    const second = await applyPrResetConversion(db, {
        conversionKey: 'reset_pr_apply',
        createdBy: 'owner@lid',
    });

    assert.equal(first.totals.pr, 128);
    assert.equal(second.duplicate, true);

    const pr = await db.get('SELECT COUNT(*) AS rows, SUM(amount) AS amount FROM clover_pr_ledger WHERE player_id = ?', ['player@lid']);
    assert.equal(pr.rows, 1);
    assert.equal(pr.amount, 128);

    const stats = await db.get('SELECT ph_accumulated, ph_available FROM clover_character_stats WHERE player_id = ?', ['player@lid']);
    assert.equal(stats.ph_accumulated, 0);
    assert.equal(stats.ph_available, 0);

    const pa = await db.get('SELECT status, paid_points FROM clover_admin_service_entries WHERE evaluator_id = ?', ['player@lid']);
    assert.equal(pa.status, 'paid');
    assert.equal(pa.paid_points, 8);

    const payout = await db.get('SELECT points_paid, ph_paid, source FROM clover_admin_service_payouts WHERE evaluator_id = ?', ['player@lid']);
    assert.equal(payout.points_paid, 8);
    assert.equal(payout.ph_paid, 0);
    assert.equal(payout.source, 'conversao_pr');
});
