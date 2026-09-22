'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    WEEKLY_COMMON_PH_LIMIT,
    mondayWeekKeyFromParts,
    planWeeklyGrant,
    resolveEffectiveDate,
} = require('../helpers/clover/weeklyPhCapService');

test('week key starts on Monday for date-only administrative effective date', () => {
    assert.equal(resolveEffectiveDate('2026-08-02').weekKey, '2026-07-27');
    assert.equal(resolveEffectiveDate('2026-08-03').weekKey, '2026-08-03');
});

test('UTC instant is classified by RPG timezone around Sunday-to-Monday boundary', () => {
    const sunday = resolveEffectiveDate('2026-08-03T02:59:59.000Z');
    const monday = resolveEffectiveDate('2026-08-03T03:00:00.000Z');

    assert.equal(sunday.localDate, '2026-08-02');
    assert.equal(sunday.weekKey, '2026-07-27');
    assert.equal(monday.localDate, '2026-08-03');
    assert.equal(monday.weekKey, '2026-08-03');
});

test('SQLite timestamp without timezone is interpreted as UTC', () => {
    const result = resolveEffectiveDate('2026-08-03 02:30:00');
    assert.equal(result.localDate, '2026-08-02');
    assert.equal(result.weekKey, '2026-07-27');
});

test('weekly grant planner caps requested PH to remaining allowance', () => {
    const plan = planWeeklyGrant({
        used: 24,
        remaining: 6,
        limit: WEEKLY_COMMON_PH_LIMIT,
        weekKey: '2026-07-27',
        effectiveDate: '2026-08-02',
    }, 10);

    assert.deepEqual(plan, {
        requested: 10,
        applied: 6,
        capped: true,
        before: 24,
        after: 30,
        remainingAfter: 0,
        weekKey: '2026-07-27',
        effectiveDate: '2026-08-02',
        limit: 30,
    });
});

test('mondayWeekKeyFromParts works independently from host timezone', () => {
    assert.equal(mondayWeekKeyFromParts({ year: 2026, month: 8, day: 7 }), '2026-08-03');
});
