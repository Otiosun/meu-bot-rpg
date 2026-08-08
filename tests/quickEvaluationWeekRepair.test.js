'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    REPAIR_SETTING_KEY,
    REPAIR_SETTING_VALUE,
    applyQuickEvaluationWeekRepair,
    getMondayWeekKeyForInstant,
    parseStoredUtcTimestamp,
    planQuickEvaluationWeekRepair,
} = require('../helpers/clover/quickEvaluationWeekRepairService');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE clover_quick_evaluations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scene_sent_at TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            week_key TEXT DEFAULT NULL
        );
        CREATE TABLE clover_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await db.run(
        `INSERT INTO clover_settings (key, value)
         VALUES ('quick_evaluation_week_key_rule', 'monday_scene_v2')`
    );
    return db;
}

test('domingo 23:59 em Sao Paulo permanece na semana anterior mesmo se o host estiver em UTC', () => {
    const beforeBoundary = parseStoredUtcTimestamp('2026-08-03 02:59:59');
    const atBoundary = parseStoredUtcTimestamp('2026-08-03 03:00:00');

    assert.equal(getMondayWeekKeyForInstant(beforeBoundary), '2026-07-27');
    assert.equal(getMondayWeekKeyForInstant(atBoundary), '2026-08-03');
});

test('repair corrige week_key historica, preserva a flag v2 e e idempotente', async () => {
    const db = await createDb();
    try {
        await db.run(
            `INSERT INTO clover_quick_evaluations (scene_sent_at, created_at, week_key)
             VALUES ('2026-08-03 02:30:00', '2026-08-03 04:00:00', '2026-08-03')`
        );
        await db.run(
            `INSERT INTO clover_quick_evaluations (scene_sent_at, created_at, week_key)
             VALUES ('2026-08-03 03:30:00', '2026-08-03 04:00:00', '2026-08-03')`
        );

        const preview = await planQuickEvaluationWeekRepair(db);
        assert.equal(preview.scanned, 2);
        assert.equal(preview.changed, 1);
        assert.deepEqual(preview.changes, [{
            id: 1,
            beforeWeekKey: '2026-08-03',
            afterWeekKey: '2026-07-27',
        }]);

        const applied = await applyQuickEvaluationWeekRepair(db, { apply: true });
        assert.equal(applied.applied, true);
        assert.equal(applied.changed, 1);

        const rows = await db.all(
            'SELECT id, week_key FROM clover_quick_evaluations ORDER BY id ASC'
        );
        assert.deepEqual(rows, [
            { id: 1, week_key: '2026-07-27' },
            { id: 2, week_key: '2026-08-03' },
        ]);

        const legacyRule = await db.get(
            `SELECT value FROM clover_settings
             WHERE key = 'quick_evaluation_week_key_rule'`
        );
        assert.equal(legacyRule.value, 'monday_scene_v2');

        const repairRule = await db.get(
            'SELECT value FROM clover_settings WHERE key = ?',
            [REPAIR_SETTING_KEY]
        );
        assert.equal(repairRule.value, REPAIR_SETTING_VALUE);

        const second = await applyQuickEvaluationWeekRepair(db, { apply: true });
        assert.equal(second.changed, 0);
        assert.equal(second.applied, true);
    } finally {
        await db.close();
    }
});

test('repair nao infere semana pela data da avaliacao e exige override para rows sem scene_sent_at', async () => {
    const db = await createDb();
    try {
        await db.run(
            `INSERT INTO clover_quick_evaluations (scene_sent_at, created_at, week_key)
             VALUES (NULL, '2026-08-03 04:00:00', '2026-07-27')`
        );

        const preview = await planQuickEvaluationWeekRepair(db);
        assert.equal(preview.scanned, 1);
        assert.equal(preview.changed, 0);
        assert.equal(preview.unchanged, 0);
        assert.equal(preview.invalid, 1);
        assert.deepEqual(preview.changes, []);

        await assert.rejects(
            () => applyQuickEvaluationWeekRepair(db, { apply: true }),
            (error) => error?.code === 'quick_evaluation_week_repair_invalid_evidence'
        );

        const settingAfterRefusal = await db.get(
            'SELECT value FROM clover_settings WHERE key = ?',
            [REPAIR_SETTING_KEY]
        );
        assert.equal(settingAfterRefusal, undefined);

        const applied = await applyQuickEvaluationWeekRepair(db, {
            apply: true,
            allowInvalid: true,
        });
        assert.equal(applied.applied, true);
        assert.equal(applied.changed, 0);
        assert.equal(applied.invalid, 1);

        const row = await db.get('SELECT week_key FROM clover_quick_evaluations WHERE id = 1');
        assert.equal(row.week_key, '2026-07-27');
    } finally {
        await db.close();
    }
});

test('preview nao altera dados', async () => {
    const db = await createDb();
    try {
        await db.run(
            `INSERT INTO clover_quick_evaluations (scene_sent_at, week_key)
             VALUES ('2026-08-03 02:00:00', '2026-08-03')`
        );

        const preview = await applyQuickEvaluationWeekRepair(db);
        assert.equal(preview.applied, false);
        assert.equal(preview.changed, 1);

        const row = await db.get('SELECT week_key FROM clover_quick_evaluations WHERE id = 1');
        assert.equal(row.week_key, '2026-08-03');
    } finally {
        await db.close();
    }
});
