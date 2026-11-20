'use strict';

const RPG_TIME_ZONE = 'America/Sao_Paulo';
const WEEKLY_COMMON_PH_LIMIT = 30;

class WeeklyPhCapError extends Error {
    constructor(code, message, details = {}) {
        super(message || code);
        this.name = 'WeeklyPhCapError';
        this.code = code;
        this.details = details;
    }
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function dateKey(year, month, day) {
    return `${year}-${pad2(month)}-${pad2(day)}`;
}

function parseDateOnly(value) {
    const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (
        probe.getUTCFullYear() !== year
        || probe.getUTCMonth() + 1 !== month
        || probe.getUTCDate() !== day
    ) {
        return null;
    }
    return { year, month, day };
}

function localDatePartsForInstant(date, timeZone = RPG_TIME_ZONE) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const parts = Object.fromEntries(
        formatter.formatToParts(date)
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, part.value])
    );
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
    };
}

function mondayWeekKeyFromParts(parts) {
    const probe = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    const daysSinceMonday = (probe.getUTCDay() + 6) % 7;
    probe.setUTCDate(probe.getUTCDate() - daysSinceMonday);
    return dateKey(probe.getUTCFullYear(), probe.getUTCMonth() + 1, probe.getUTCDate());
}

function parseInstant(value) {
    if (value instanceof Date) return new Date(value.getTime());
    const text = String(value || '').trim();
    if (!text) return new Date();

    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(text)) {
        return new Date(`${text.replace(' ', 'T')}Z`);
    }
    return new Date(text);
}

function resolveEffectiveDate(value, options = {}) {
    const dateOnly = parseDateOnly(value);
    if (dateOnly) {
        return {
            localDate: dateKey(dateOnly.year, dateOnly.month, dateOnly.day),
            weekKey: mondayWeekKeyFromParts(dateOnly),
            source: 'date_only',
        };
    }

    const instant = parseInstant(value);
    if (Number.isNaN(instant.getTime())) {
        throw new WeeklyPhCapError(
            'invalid_effective_date',
            'A data efetiva do PH é inválida.',
            { value }
        );
    }
    const parts = localDatePartsForInstant(instant, options.timeZone || RPG_TIME_ZONE);
    return {
        localDate: dateKey(parts.year, parts.month, parts.day),
        weekKey: mondayWeekKeyFromParts(parts),
        instant: instant.toISOString(),
        source: 'instant',
    };
}

async function ensureWeeklyPhCapSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_admin_weekly_ph_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usage_key TEXT NOT NULL UNIQUE,
            player_id TEXT NOT NULL,
            week_key TEXT NOT NULL,
            effective_date TEXT NOT NULL,
            requested_amount INTEGER NOT NULL CHECK (requested_amount > 0),
            applied_amount INTEGER NOT NULL CHECK (applied_amount >= 0),
            status TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'voided')),
            operation_code TEXT DEFAULT NULL,
            source TEXT NOT NULL DEFAULT 'admin_reward',
            reason TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            voided_by TEXT DEFAULT NULL,
            voided_at TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_admin_weekly_ph_player_week
        ON clover_admin_weekly_ph_usage (player_id, week_key, status, id)
    `);
}

async function readQuickEvaluationWeeklyUsage(db, playerId, weekKey) {
    const row = await db.get(
        `SELECT COALESCE(SUM(ph_amount), 0) AS total
         FROM clover_quick_evaluations
         WHERE player_id = ?
           AND week_key = ?
           AND bypass_weekly_limit = 0
           AND COALESCE(json_extract(metadata_json, '$.voided_by_correction'), 0) != 1
           AND COALESCE(json_extract(rewards_json, '$.cap'), '') != 'anulado'`,
        [playerId, weekKey]
    );
    return Number(row?.total || 0);
}

// PA salary and scene-based PH already share the original common cap.
// The native PA shop used both sources, while quick-evaluation and admin
// weekly grants previously read only evaluations. Keep the date key supplied
// by the caller: no reclassification of historical weeks or mission rewards.
async function readCommonWeeklyPhUsage(db,playerId,weekKey){
    const quick=await readQuickEvaluationWeeklyUsage(db,playerId,weekKey);
    // Older isolated databases can predate the PA schema. No table means no
    // PA payouts; an existing table with unexpected schema must fail loudly.
    const table=await db.get("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='clover_admin_service_payouts'");
    if(!table)return quick;
    const salary=await db.get("SELECT COALESCE(SUM(ph_paid),0) AS total FROM clover_admin_service_payouts WHERE player_id=? AND week_key=?",[playerId,weekKey]);
    return quick+Number(salary?.total||0);
}

async function getWeeklyPhCapSummary(db, playerId, effectiveDate, options = {}) {
    await ensureWeeklyPhCapSchema(db);
    const resolved = resolveEffectiveDate(effectiveDate || new Date(), options);
    const used = await readCommonWeeklyPhUsage(db, playerId, resolved.weekKey);
    const limit = Number(options.limit || WEEKLY_COMMON_PH_LIMIT);
    return {
        playerId,
        weekKey: resolved.weekKey,
        effectiveDate: resolved.localDate,
        used,
        limit,
        remaining: Math.max(0, limit - used),
        exhausted: used >= limit,
        timeZone: options.timeZone || RPG_TIME_ZONE,
    };
}

function planWeeklyGrant(summary, requestedAmount) {
    const requested = Number(requestedAmount);
    if (!Number.isSafeInteger(requested) || requested <= 0) {
        throw new WeeklyPhCapError(
            'invalid_weekly_ph_amount',
            'O PH semanal precisa ser um inteiro positivo.',
            { requestedAmount }
        );
    }
    const applied = Math.min(requested, Math.max(0, Number(summary.remaining || 0)));
    return {
        requested,
        applied,
        capped: applied < requested,
        before: Number(summary.used || 0),
        after: Number(summary.used || 0) + applied,
        remainingAfter: Math.max(0, Number(summary.limit || WEEKLY_COMMON_PH_LIMIT) - (Number(summary.used || 0) + applied)),
        weekKey: summary.weekKey,
        effectiveDate: summary.effectiveDate,
        limit: Number(summary.limit || WEEKLY_COMMON_PH_LIMIT),
    };
}

function safeMetadata(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function findUsage(db, usageKey) {
    await ensureWeeklyPhCapSchema(db);
    return db.get(
        'SELECT * FROM clover_admin_weekly_ph_usage WHERE usage_key = ?',
        [String(usageKey || '').trim()]
    );
}

async function recordWeeklyPhUsageInTransaction(db, input = {}) {
    await ensureWeeklyPhCapSchema(db);
    const usageKey = String(input.usageKey || '').trim();
    if (!usageKey) throw new WeeklyPhCapError('missing_usage_key', 'A chave do consumo semanal é obrigatória.');

    const existing = await findUsage(db, usageKey);
    if (existing) {
        if (
            existing.player_id !== input.playerId
            || Number(existing.requested_amount) !== Number(input.requestedAmount)
            || existing.week_key !== input.weekKey
        ) {
            throw new WeeklyPhCapError(
                'weekly_ph_idempotency_conflict',
                'A chave deste consumo semanal pertence a outro lançamento.'
            );
        }
        return {
            ok: true,
            duplicate: true,
            id: Number(existing.id),
            usageKey,
            requested: Number(existing.requested_amount),
            applied: Number(existing.applied_amount),
            weekKey: existing.week_key,
            effectiveDate: existing.effective_date,
            status: existing.status,
        };
    }

    const requested = Number(input.requestedAmount);
    const applied = Number(input.appliedAmount);
    if (!Number.isSafeInteger(requested) || requested <= 0 || !Number.isSafeInteger(applied) || applied < 0 || applied > requested) {
        throw new WeeklyPhCapError('invalid_weekly_ph_usage', 'O registro de PH semanal é inválido.');
    }

    const inserted = await db.run(
        `INSERT INTO clover_admin_weekly_ph_usage
         (usage_key, player_id, week_key, effective_date, requested_amount, applied_amount,
          status, operation_code, source, reason, created_by, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
        [
            usageKey,
            input.playerId,
            input.weekKey,
            input.effectiveDate,
            requested,
            applied,
            input.operationCode || null,
            input.source || 'admin_reward',
            input.reason || null,
            input.createdBy || null,
            JSON.stringify(safeMetadata(input.metadata)),
        ]
    );

    if (applied > 0) {
        const messageKey = `admin-weekly-ph:${usageKey}`;
        const metadata = {
            ...safeMetadata(input.metadata),
            administrative_weekly_ph: true,
            hidden_from_evaluation_feed: true,
            usage_key: usageKey,
            operation_code: input.operationCode || null,
        };
        await db.run(
            `INSERT INTO clover_quick_evaluations
             (message_key, quoted_message_key, chat_id, player_id, evaluator_id,
              modality_key, modality_label, ph_amount, yulls_amount, stars_amount,
              inventory_text, scene_sent_at, scene_source, evaluated_at, week_key,
              bypass_weekly_limit, rewards_json, created_at, metadata_json)
             VALUES (?, NULL, 'admin-central', ?, ?, 'admin_weekly_ph',
                     'PH administrativo dentro do teto', ?, 0, 0, NULL, ?,
                     'admin_effective_date', CURRENT_TIMESTAMP, ?, 0, ?, CURRENT_TIMESTAMP, ?)`,
            [
                messageKey,
                input.playerId,
                input.createdBy || 'system',
                applied,
                `${input.effectiveDate} 12:00:00`,
                input.weekKey,
                JSON.stringify({ ph: applied, cap: 'semanal', source: input.source || 'admin_reward' }),
                JSON.stringify(metadata),
            ]
        );
    }

    return {
        ok: true,
        duplicate: false,
        id: Number(inserted.lastID),
        usageKey,
        requested,
        applied,
        weekKey: input.weekKey,
        effectiveDate: input.effectiveDate,
        status: 'active',
    };
}

async function voidWeeklyPhUsageInTransaction(db, usageKey, actorId, reason = null) {
    const usage = await findUsage(db, usageKey);
    if (!usage) {
        throw new WeeklyPhCapError('weekly_ph_usage_not_found', 'Consumo semanal não encontrado.');
    }
    if (usage.status === 'voided') {
        return { ok: true, duplicate: true, usageKey, status: 'voided' };
    }

    await db.run(
        `UPDATE clover_admin_weekly_ph_usage
         SET status = 'voided', voided_by = ?, voided_at = CURRENT_TIMESTAMP,
             metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.void_reason', ?)
         WHERE usage_key = ? AND status = 'active'`,
        [actorId || null, reason || null, usageKey]
    );
    await db.run(
        `UPDATE clover_quick_evaluations
         SET ph_amount = 0,
             bypass_weekly_limit = 1,
             rewards_json = json_set(COALESCE(rewards_json, '{}'), '$.cap', 'anulado'),
             metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.voided_by_correction', 1)
         WHERE message_key = ?`,
        [`admin-weekly-ph:${usageKey}`]
    );
    return { ok: true, duplicate: false, usageKey, status: 'voided' };
}

module.exports = {
    RPG_TIME_ZONE,
    WEEKLY_COMMON_PH_LIMIT,
    WeeklyPhCapError,
    ensureWeeklyPhCapSchema,
    getWeeklyPhCapSummary,
    mondayWeekKeyFromParts,
    planWeeklyGrant,
    readQuickEvaluationWeeklyUsage,
    readCommonWeeklyPhUsage,
    recordWeeklyPhUsageInTransaction,
    resolveEffectiveDate,
    voidWeeklyPhUsageInTransaction,
};
