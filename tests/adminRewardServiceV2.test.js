'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    PH_CAP_POLICIES,
    REWARD_ENTRY_TYPES_V2,
    normalizeRewardEntriesV2,
} = require('../helpers/clover/adminRewardServiceV2');

test('Reward V2 exposes the first economic parity set', () => {
    assert.deepEqual(REWARD_ENTRY_TYPES_V2, ['yulls', 'ph', 'pa', 'pm', 'item', 'box']);
    assert.deepEqual(PH_CAP_POLICIES, ['outside_weekly', 'weekly', 'adjustment']);
});

test('normalizes weekly PH with effective scene date', () => {
    const [entry] = normalizeRewardEntriesV2([{
        type: 'ph',
        amount: 10,
        capPolicy: 'weekly',
        effectiveDate: '2026-08-02',
    }]);

    assert.equal(entry.type, 'ph');
    assert.equal(entry.amount, 10);
    assert.equal(entry.capPolicy, 'weekly');
    assert.equal(entry.effectiveDate, '2026-08-02');
    assert.match(entry.label, /teto semanal/i);
});

test('normalizes PH outside weekly cap and administrative adjustment explicitly', () => {
    const outside = normalizeRewardEntriesV2([{ type: 'ph', amount: 5, capPolicy: 'fora_do_teto' }])[0];
    const adjustment = normalizeRewardEntriesV2([{ type: 'ph', amount: 5, capPolicy: 'ajuste' }])[0];

    assert.equal(outside.capPolicy, 'outside_weekly');
    assert.equal(adjustment.capPolicy, 'adjustment');
});

test('supports PA, PM, item and box without converting them to generic metadata', () => {
    const entries = normalizeRewardEntriesV2([
        { type: 'pa', amount: 2 },
        { type: 'pm', amount: 3 },
        { type: 'item', templateKey: 'custom_espada', quantity: 1 },
        { type: 'box', templateKey: 'caixa_simples', quantity: 2 },
    ]);

    assert.deepEqual(entries.map((entry) => entry.type), ['pa', 'pm', 'item', 'box']);
    assert.equal(entries[2].templateKey, 'custom_espada');
    assert.equal(entries[3].templateKey, 'caixa_simples');
});

test('rejects unsupported future reward types instead of silently guessing', () => {
    assert.throws(
        () => normalizeRewardEntriesV2([{ type: 'title', key: 'campeao' }]),
        (error) => error?.code === 'unsupported_reward_entry'
    );
});
