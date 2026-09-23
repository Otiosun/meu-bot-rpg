'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { processAttempts } = require('../temp/return-shop-dry-run-v5-20260907');

function state() {
    return { balances: { asta: 400, cafeina: 1000 }, stock: {}, spent: {},
        normalUsage: {}, exclusiveChoices: {}, notes: new Set() };
}

test('replay disputa saldo na ordem de horario, nao na ordem das duas lojas', () => {
    const rows = processAttempts(state(), [
        { seq: 1, time: '02:00', player: 'asta', shop: 'global', items: [{ key: 'bindings', quantity: 1 }] },
        { seq: 2, time: '01:00', player: 'asta', shop: 'normal', items: [{ key: 'royalBox', quantity: 2 }] },
    ]);
    assert.deepEqual(rows.map(row => [row.seq, row.status]), [[2, 'approved'], [1, 'failed']]);
});

test('limite individual vale para item normal mesmo quando pedido na loja global', () => {
    const rows = processAttempts(state(), [
        { seq: 1, time: '00:20', player: 'cafeina', shop: 'global', items: [{ key: 'royalBox', quantity: 5 }] },
        { seq: 2, time: '00:21', player: 'cafeina', shop: 'normal', items: [{ key: 'royalBox', quantity: 1 }] },
    ]);
    assert.deepEqual(rows.map(row => row.status), ['approved', 'failed']);
    assert.match(rows[1].reason, /limite individual/);
});
