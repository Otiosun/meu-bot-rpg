'use strict';

const RPG_TIME_ZONE = 'America/Sao_Paulo';
const REPAIR_SETTING_KEY = 'quick_evaluation_week_key_repair';
const REPAIR_SETTING_VALUE = 'scene_utc_sao_paulo_v3';

function pad2(value) {
    return String(value).padStart(2, '0');
}

function parseStoredUtcTimestamp(value) {
    if (value instanceof Date) {
        const copy = new Date(value.getTime());
        return Number.isNaN(copy.getTime()) ? null : copy;
    }

    const text = String(value || '').trim();
    if (!text) return null;

    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        const parsed = new Date(`${text}T15:00:00Z`);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    if (/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?$/.test(text)) {
        const normalized = text.replace(' ', 'T');
        const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}$/.test(normalized)
            ? `${normalized}:00`
            : normalized;
        const parsed = new Date(`${withSeconds}Z`);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function zonedDateParts(date, timeZone = RPG_TIME_ZONE) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const parts = formatter.formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
        year: Number(values.year),
        month: Number(values.month),
        day: Number(values.day),
    };
}

function getMondayWeekKeyForInstant(date, timeZone = RPG_TIME_ZONE) {
    const instant = date instanceof Date ? new Date(date.getTime()) : parseStoredUtcTimestamp(date);
    if (!instant || Number.isNaN(instant.getTime())) return null;

    const local = zonedDateParts(instant, timeZone);
    const civilDate = new Date(Date.UTC(local.year, local.month - 1, local.day, 12, 0, 0));
    const daysSinceMonday = (civilDate.getUTCDay() + 6) % 7;
    civilDate.setUTCDate(civilDate.getUTCDate() - daysSinceMonday);

    return `${civilDate.getUTCFullYear()}-${pad2(civilDate.getUTCMonth() + 1)}-${pad2(civilDate.getUTCDate())}`;
}

function getExpectedQuickEvaluationWeekKey(row, options = {}) {
    const timeZone = options.timeZone || RPG_TIME_ZONE;
    // Fail closed: historical repair is only justified by actual scene evidence.
    // created_at is the evaluation time and may belong to a different RPG week.
    const instant = parseStoredUtcTimestamp(row?.scene_sent_at || null);
    if (!instant) return null;
    return getMondayWeekKeyForInstant(instant, timeZone);
}

async function quickEvaluationTableExists(db) {
    const row = await db.get(
        `SELECT 1 AS present
         FROM sqlite_master
         WHERE type = 'table' AND name = 'clover_quick_evaluations'
         LIMIT 1`
    );
    return Boolean(row?.present);
}

async function planQuickEvaluationWeekRepair(db, options = {}) {
    if (!await quickEvaluationTableExists(db)) {
        return {
            ok: true,
            tableExists: false,
            scanned: 0,
            changed: 0,
            unchanged: 0,
            invalid: 0,
            changes: [],
        };
    }

    const rows = await db.all(
        `SELECT id, scene_sent_at, created_at, week_key
         FROM clover_quick_evaluations
         ORDER BY id ASC`
    );
    const changes = [];
    let unchanged = 0;
    let invalid = 0;

    for (const row of rows) {
        const expectedWeekKey = getExpectedQuickEvaluationWeekKey(row, options);
        if (!expectedWeekKey) {
            invalid += 1;
            continue;
        }
        if (String(row.week_key || '') === expectedWeekKey) {
            unchanged += 1;
            continue;
        }
        changes.push({
            id: Number(row.id),
            beforeWeekKey: row.week_key || null,
            afterWeekKey: expectedWeekKey,
        });
    }

    return {
        ok: true,
        tableExists: true,
        scanned: rows.length,
        changed: changes.length,
        unchanged,
        invalid,
        changes,
    };
}

async function ensureRepairSettingSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

function invalidEvidenceError(plan) {
    const error = new Error(
        `Reparo recusado: ${plan.invalid} avaliacao(oes) nao possuem scene_sent_at valido. ` +
        'Revise esses casos antes de aplicar ou use allowInvalid conscientemente para corrigir apenas os casos comprovaveis.'
    );
    error.code = 'quick_evaluation_week_repair_invalid_evidence';
    error.invalid = plan.invalid;
    return error;
}

async function applyQuickEvaluationWeekRepair(db, options = {}) {
    const preview = await planQuickEvaluationWeekRepair(db, options);
    if (!preview.tableExists || options.apply !== true) {
        return { ...preview, applied: false };
    }

    await ensureRepairSettingSchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        // Re-plan under the write lock so preview/apply cannot overwrite a concurrent change.
        const plan = await planQuickEvaluationWeekRepair(db, options);
        if (plan.invalid > 0 && options.allowInvalid !== true) {
            throw invalidEvidenceError(plan);
        }

        for (const change of plan.changes) {
            await db.run(
                'UPDATE clover_quick_evaluations SET week_key = ? WHERE id = ?',
                [change.afterWeekKey, change.id]
            );
        }

        await db.run(
            `INSERT INTO clover_settings (key, value, updated_at)
             VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO UPDATE SET
                 value = excluded.value,
                 updated_at = CURRENT_TIMESTAMP`,
            [REPAIR_SETTING_KEY, REPAIR_SETTING_VALUE]
        );

        await db.exec('COMMIT');
        return { ...plan, applied: true };
    } catch (error) {
        try {
            await db.exec('ROLLBACK');
        } catch {}
        throw error;
    }
}

module.exports = {
    REPAIR_SETTING_KEY,
    REPAIR_SETTING_VALUE,
    RPG_TIME_ZONE,
    applyQuickEvaluationWeekRepair,
    getExpectedQuickEvaluationWeekKey,
    getMondayWeekKeyForInstant,
    parseStoredUtcTimestamp,
    planQuickEvaluationWeekRepair,
};
