'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    AdminQuickRewardError,
    createQuickRewardExecutor,
    normalizeQuickEntries,
} = require('../helpers/clover/adminQuickRewardService');

test('quick reward accepts economic entries, stars, item and box', () => {
    const entries = normalizeQuickEntries([
        { type: 'yulls', amount: 5000 },
        { type: 'ph', amount: 8, capPolicy: 'weekly', effectiveDate: '2026-08-02' },
        { type: 'pa', amount: 2 },
        { type: 'pm', amount: 3 },
        { type: 'stars', amount: 4 },
        { type: 'item', templateKey: 'custom_espada', quantity: 1 },
        { type: 'box', templateKey: 'caixa_simples', quantity: 2 },
    ]);

    assert.deepEqual(entries.map((entry) => entry.type), [
        'yulls',
        'ph',
        'pa',
        'pm',
        'stars',
        'item',
        'box',
    ]);
    assert.equal(entries[1].capPolicy, 'weekly');
    assert.equal(entries[1].effectiveDate, '2026-08-02');
    assert.equal(entries[4].amount, 4);
});

test('quick reward rejects a second stars entry instead of summing ambiguously', () => {
    assert.throws(
        () => normalizeQuickEntries([
            { type: 'stars', amount: 1 },
            { type: 'estrelas', amount: 2 },
        ]),
        (error) => error instanceof AdminQuickRewardError && error.code === 'duplicate_quick_stars'
    );
});

test('quick reward preserves explicit PH policies', () => {
    const weekly = normalizeQuickEntries([{ type: 'ph', amount: 3, capPolicy: 'weekly', effectiveDate: '2026-08-03' }])[0];
    const outside = normalizeQuickEntries([{ type: 'ph', amount: 3, capPolicy: 'outside_weekly' }])[0];
    const adjustment = normalizeQuickEntries([{ type: 'ph', amount: 3, capPolicy: 'adjustment' }])[0];

    assert.equal(weekly.capPolicy, 'weekly');
    assert.equal(outside.capPolicy, 'outside_weekly');
    assert.equal(adjustment.capPolicy, 'adjustment');
});

test('wrapper delegates legacy package grants when quickEntries is absent', async () => {
    const calls = [];
    const fallback = {
        async preview(context) {
            calls.push(['preview', context]);
            return { summary: 'package-preview' };
        },
        async apply(context) {
            calls.push(['apply', context]);
            return { summary: 'package-apply' };
        },
        async undo(context) {
            calls.push(['undo', context]);
            return { ok: true };
        },
    };
    const executor = createQuickRewardExecutor(fallback);
    const context = { action: { payload: { packageId: 'RW-1' } } };

    assert.equal((await executor.preview(context)).summary, 'package-preview');
    assert.equal((await executor.apply(context)).summary, 'package-apply');
    assert.deepEqual(await executor.undo(context), { ok: true });
    assert.deepEqual(calls.map(([kind]) => kind), ['preview', 'apply', 'undo']);
});

test('quick undo delegates to package executor when persisted result is not quick', async () => {
    let undoCalls = 0;
    const executor = createQuickRewardExecutor({
        async preview() { return {}; },
        async apply() { return {}; },
        async undo() {
            undoCalls += 1;
            return { packageUndo: true };
        },
    });

    const result = await executor.undo({ after: { quickReward: false } });
    assert.equal(undoCalls, 1);
    assert.deepEqual(result, { packageUndo: true });
});
