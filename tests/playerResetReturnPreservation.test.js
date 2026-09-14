'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarBanco } = require('../database');
const { creditReturnPoints, debitReturnPoints } = require('../helpers/clover/returnPointsService');
const { resetPlayer, restorePlayerReset } = require('../helpers/clover/playerResetService');

test('modern reset and restore preserve return ledger and active/consumed entitlements exactly', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-reset-return-preservation-'));
    const db = await criarBanco({ filename: path.join(directory, 'database.sqlite') });
    t.after(async () => { await db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const playerId = 'return-preservation-player';
    await db.run("INSERT INTO jogadores (id, nome, personagem_nome) VALUES (?, 'Player', 'Character')", [playerId]);
    await creditReturnPoints(db, playerId, 100, { operationKey: 'preservation-credit', source: 'test', reason: 'Synthetic credit', createdBy: 'test' });
    for (const status of ['active', 'consumed']) {
        const debit = await debitReturnPoints(db, playerId, 10, { operationKey: `preservation-debit-${status}`, source: 'test', reason: 'Synthetic purchase', createdBy: 'test' });
        const purchase = await db.run(`INSERT INTO clover_prereset_purchases
            (player_id, idempotency_key, catalog_item_key, entitlement_key, price_return_points, return_points_ledger_id, metadata_json)
            VALUES (?, ?, 'synthetic-item', ?, 10, ?, ?)`,
        [playerId, `purchase-${status}`, `entitlement-${status}`, debit.ledgerId, JSON.stringify({ effectKind: 'future_yulls', effectValue: 1000, targetRollNumber: null, test_only_prereset_shop_gate_bypass: 1 })]);
        await db.run('INSERT INTO clover_prereset_entitlements (player_id, entitlement_key, purchase_id, status, metadata_json) VALUES (?, ?, ?, ?, ?)',
            [playerId, `entitlement-${status}`, purchase.lastID, status, JSON.stringify({ effectKind: 'future_yulls', effectValue: 1000, targetRollNumber: null })]);
    }
    const snapshot = async () => Promise.all(['clover_return_points_ledger', 'clover_prereset_purchases', 'clover_prereset_entitlements'].map((table) => db.all(`SELECT * FROM ${table} WHERE player_id = ? ORDER BY id`, [playerId])));
    const before = await snapshot();
    const reset = await resetPlayer(db, { playerId, reason: 'Synthetic reset', actorId: 'test', operationCode: 'RS-RETURNPRESERVE' });
    assert.equal(reset.ok, true);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await db.get('SELECT personagem_nome FROM jogadores WHERE id = ?', [playerId])).personagem_nome, '-');
    const restored = await restorePlayerReset(db, { sourceCode: 'RS-RETURNPRESERVE', reason: 'Synthetic restore', actorId: 'test', operationCode: 'RR-RETURNPRESERVE' });
    assert.equal(restored.ok, true);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await db.get('SELECT personagem_nome FROM jogadores WHERE id = ?', [playerId])).personagem_nome, 'Character');
});
