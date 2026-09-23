'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    getPrHistory,
    getPrSummary,
} = require('../helpers/clover/prService');

async function setup() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT NULL,
            display_name TEXT DEFAULT NULL,
            personagem_nome TEXT DEFAULT NULL
        );
        CREATE TABLE clover_return_points_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL,
            entry_kind TEXT DEFAULT NULL,
            operation_key TEXT DEFAULT NULL,
            source TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            policy_version TEXT DEFAULT NULL,
            reset_cycle_key TEXT DEFAULT NULL,
            related_id TEXT DEFAULT NULL,
            correlation_id TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        );
        INSERT INTO jogadores (id, nome, personagem_nome)
        VALUES ('player@lid', 'Player', '-');
    `);
    return db;
}

test('getPrSummary usa saldo liquido do PR de Retorno quando existe ledger de retorno', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    await db.exec(`
        INSERT INTO clover_return_points_ledger
            (player_id, amount, entry_kind, source, reason, operation_key, created_at)
        VALUES
            ('player@lid', 500, 'credit', 'ph_to_pr_conversion', 'Conversao PH', 'conversion:1', '2026-09-07 10:00:00'),
            ('player@lid', -180, 'debit', 'return_shop_purchase', 'Loja de Retorno', 'shop:1', '2026-09-07 10:05:00');
    `);

    const summary = await getPrSummary(db, 'player@lid');

    assert.equal(summary.balance, 320);
    assert.equal(summary.balanceSource, 'return_points');
    assert.equal(summary.returnBalance, 320);
});

test('getPrHistory lista extrato de PR de Retorno quando esse ledger existe', async (t) => {
    const db = await setup();
    t.after(() => db.close());

    await db.exec(`
        INSERT INTO clover_return_points_ledger
            (player_id, amount, entry_kind, source, reason, operation_key, created_at)
        VALUES
            ('player@lid', 500, 'credit', 'ph_to_pr_conversion', 'Conversao PH', 'conversion:1', '2026-09-07 10:00:00'),
            ('player@lid', -180, 'debit', 'return_shop_purchase', 'Loja de Retorno', 'shop:1', '2026-09-07 10:05:00');
    `);

    const history = await getPrHistory(db, 'player@lid', 5);

    assert.equal(history.length, 2);
    assert.equal(history[0].amount, -180);
    assert.equal(history[0].kind, 'debit');
    assert.equal(history[0].source, 'return_shop_purchase');
    assert.equal(history[1].amount, 500);
});
