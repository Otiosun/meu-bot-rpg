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

test('teto comum contabiliza PH de cenas e PA convertido uma única vez, excluindo registros anulados',async t=>{
    const {open}=require('sqlite');
    const sqlite3=require('sqlite3');
    const {readCommonWeeklyPhUsage,getWeeklyPhCapSummary}=require('../helpers/clover/weeklyPhCapService');
    const db=await open({filename:':memory:',driver:sqlite3.Database});
    t.after(()=>db.close());
    await db.exec("CREATE TABLE clover_quick_evaluations(player_id TEXT,week_key TEXT,ph_amount INTEGER,bypass_weekly_limit INTEGER,metadata_json TEXT,rewards_json TEXT); CREATE TABLE clover_admin_service_payouts(player_id TEXT,week_key TEXT,ph_paid INTEGER);");
    await db.exec("INSERT INTO clover_quick_evaluations VALUES ('p','2026-11-16',18,0,'{}','{}'),('p','2026-11-16',5,0,'{\"voided_by_correction\":1}','{}'),('p','2026-11-16',4,0,'{}','{\"cap\":\"anulado\"}'),('p','2026-11-16',60,1,'{}','{}'),('p','2026-11-09',30,0,'{}','{}'),('other','2026-11-16',20,0,'{}','{}'); INSERT INTO clover_admin_service_payouts VALUES('p','2026-11-16',8),('p','2026-11-09',20),('other','2026-11-16',15);");
    assert.equal(await readCommonWeeklyPhUsage(db,'p','2026-11-16'),26);
    const summary=await getWeeklyPhCapSummary(db,'p','2026-11-20');
    assert.equal(summary.used,26);
    assert.equal(summary.remaining,4);
    assert.equal(planWeeklyGrant(summary,10).applied,4);
    await db.run("INSERT INTO clover_admin_service_payouts VALUES('p','2026-11-16',4)");
    assert.equal((await getWeeklyPhCapSummary(db,'p','2026-11-20')).exhausted,true);
});
