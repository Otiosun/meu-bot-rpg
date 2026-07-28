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
} = require('../database');
const { purchasePhBySceneWeek } = require('../helpers/clover/paSceneWeekService');

const PLAYER = 'player@lid';

async function setup() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            dinheiro INTEGER DEFAULT 0,
            jogo_status TEXT DEFAULT 'liberado'
        );
    `);
    await db.run(
        `INSERT INTO jogadores (id, personagem_nome, jogo_status)
         VALUES (?, 'Avaliador Teste', 'liberado')`,
        [PLAYER]
    );
    await ensureCloverCharacterStatsSchema(db);
    await ensureCloverPhLedgerSchema(db);
    await ensureCloverQuickEvaluationsSchema(db);
    await ensureCloverAdminServiceSchema(db);
    return db;
}

async function addServicePa(db, points, weekKey) {
    await db.run(
        `INSERT INTO clover_admin_service_entries
         (evaluator_id, target_player_id, modality_key, modality_label, weight,
          points, paid_points, status, service_week_key, scene_week_key, created_by)
         VALUES (?, ?, 'teste', 'Teste', 1, ?, 0, 'pending', ?, ?, ?)`,
        [PLAYER, PLAYER, points, weekKey, weekKey, PLAYER]
    );
}

async function addUsedPh(db, amount, weekKey) {
    await db.run(
        `INSERT INTO clover_quick_evaluations
         (message_key, chat_id, player_id, evaluator_id, modality_key, modality_label,
          ph_amount, week_key, bypass_weekly_limit)
         VALUES (?, 'chat@g.us', ?, 'admin@lid', 'teste', 'Teste', ?, ?, 0)`,
        [`msg:${weekKey}:${amount}`, PLAYER, amount, weekKey]
    );
}

test('compra de PH converte automaticamente o maximo que cabe nas semanas de origem', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    await addServicePa(db, 20, '2026-07-20');
    await addUsedPh(db, 25, '2026-07-20');

    const result = await purchasePhBySceneWeek(db, PLAYER, {
        quantity: 20,
        idempotencyKey: 'pa-scene-week:partial',
    });

    assert.equal(result.ok, true);
    assert.equal(result.quantity, 5);
    assert.equal(result.requestedQuantity, 20);
    assert.equal(result.partialByCap, true);
    assert.equal(result.availablePaAfter, 15);
    assert.deepEqual(
        result.originAllocations.map((entry) => [entry.weekKey, entry.amount, entry.usedBefore, entry.usedAfter]),
        [['2026-07-20', 5, 25, 30]]
    );
});

test('compra de PH sem quantidade compra todo PH possivel agora', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    await addServicePa(db, 12, '2026-07-20');
    await addUsedPh(db, 22, '2026-07-20');

    const result = await purchasePhBySceneWeek(db, PLAYER, {
        idempotencyKey: 'pa-scene-week:auto-max',
    });

    assert.equal(result.ok, true);
    assert.equal(result.quantity, 8);
    assert.equal(result.partialByCap, false);
    assert.equal(result.availablePaAfter, 4);
});
