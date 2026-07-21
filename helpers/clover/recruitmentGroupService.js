'use strict';

const { ensureCloverRecruitmentSchema } = require('../../database');
const {
    DEFAULT_EVENT_KEY,
    getEvent,
    getMondayWeekKey,
    getPrBalance,
} = require('./prService');

const GROUP_PR_RATE = 0.4;
const GROUP_WEEKLY_LIMIT = 50;

class RecruitmentGroupServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'RecruitmentGroupServiceError';
        this.code = code;
        this.details = details;
    }
}

function roundPr(value) {
    return Math.round((Number(value) + Number.EPSILON) * 10) / 10;
}

function normalizeOptional(value) {
    const text = String(value || '').trim();
    return text || null;
}

function parseSqliteDate(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const parsed = new Date(text.includes('T') ? text : text.replace(' ', 'T'));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isEventActive(event, at = new Date()) {
    if (String(event?.status || '') !== 'active') return false;
    const now = new Date(at);
    const startsAt = parseSqliteDate(event?.starts_at);
    const endsAt = parseSqliteDate(event?.ends_at);
    if (startsAt && now < startsAt) return false;
    if (endsAt && now > endsAt) return false;
    return true;
}

async function ensureRecruitmentGroupSchema(db) {
    await ensureCloverRecruitmentSchema(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_recruitment_group_submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            week_key TEXT NOT NULL,
            groups_reported INTEGER NOT NULL CHECK (groups_reported > 0),
            groups_credited INTEGER NOT NULL CHECK (groups_credited >= 0),
            groups_excess INTEGER NOT NULL CHECK (groups_excess >= 0),
            pr_rate REAL NOT NULL CHECK (pr_rate >= 0),
            pr_awarded REAL NOT NULL CHECK (pr_awarded >= 0),
            ledger_id INTEGER DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            related_id TEXT DEFAULT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL,
            FOREIGN KEY (event_id) REFERENCES clover_recruitment_events(id),
            FOREIGN KEY (ledger_id) REFERENCES clover_pr_ledger(id)
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_group_submissions_player_week
        ON clover_recruitment_group_submissions (player_id, event_id, week_key, id)
    `);
}

async function ensurePlayerExists(db, playerId) {
    const player = await db.get('SELECT id FROM jogadores WHERE id = ?', [playerId]);
    if (!player) {
        throw new RecruitmentGroupServiceError('player_not_found', 'Player não encontrado.');
    }
}

async function getSubmissionTotals(db, playerId, eventId, weekKey) {
    const row = await db.get(
        `SELECT
            COALESCE(SUM(groups_reported), 0) AS groups_reported,
            COALESCE(SUM(groups_credited), 0) AS groups_credited,
            COALESCE(SUM(groups_excess), 0) AS groups_excess,
            COALESCE(SUM(pr_awarded), 0) AS pr_awarded,
            COUNT(*) AS submissions
         FROM clover_recruitment_group_submissions
         WHERE player_id = ? AND event_id = ? AND week_key = ?`,
        [playerId, eventId, weekKey]
    );
    return {
        groupsReported: Number(row?.groups_reported || 0),
        groupsCredited: Number(row?.groups_credited || 0),
        groupsExcess: Number(row?.groups_excess || 0),
        prAwarded: roundPr(row?.pr_awarded || 0),
        submissions: Number(row?.submissions || 0),
    };
}

async function getLedgerGroupPr(db, playerId, eventId, weekKey) {
    const row = await db.get(
        `SELECT COALESCE(SUM(amount), 0) AS earned
         FROM clover_pr_ledger
         WHERE player_id = ?
           AND event_id = ?
           AND source = 'divulgacao_grupo'
           AND week_key = ?`,
        [playerId, eventId, weekKey]
    );
    return roundPr(Math.max(0, Number(row?.earned || 0)));
}

async function getGroupPromotionDashboard(db, playerId, options = {}) {
    await ensureRecruitmentGroupSchema(db);
    await ensurePlayerExists(db, playerId);
    const event = await getEvent(db, options.eventKey || DEFAULT_EVENT_KEY);
    const weekKey = options.weekKey || getMondayWeekKey(options.at || new Date());
    const totals = await getSubmissionTotals(db, playerId, event.id, weekKey);
    const prEarned = await getLedgerGroupPr(db, playerId, event.id, weekKey);
    const prLimit = Number(event.group_weekly_pr_limit || 20);
    const balance = roundPr(await getPrBalance(db, playerId));
    return {
        playerId,
        eventKey: event.event_key,
        eventStatus: event.status,
        weekKey,
        rate: GROUP_PR_RATE,
        groupLimit: GROUP_WEEKLY_LIMIT,
        prLimit,
        groupsReported: totals.groupsReported,
        groupsCredited: totals.groupsCredited,
        groupsExcess: totals.groupsExcess,
        groupsRemaining: Math.max(0, GROUP_WEEKLY_LIMIT - totals.groupsCredited),
        prEarned,
        prRemaining: roundPr(Math.max(0, prLimit - prEarned)),
        submissions: totals.submissions,
        balance,
    };
}

async function recordGroupPromotion(db, playerId, groupsInput, reason, createdBy, options = {}) {
    const groupsReported = Number(groupsInput);
    if (!Number.isInteger(groupsReported) || groupsReported <= 0) {
        throw new RecruitmentGroupServiceError('invalid_group_count', 'Informe uma quantidade positiva de grupos.');
    }
    if (groupsReported > 100000) {
        throw new RecruitmentGroupServiceError('group_count_too_large', 'A quantidade de grupos informada é alta demais para um único lançamento.');
    }
    const idempotencyKey = normalizeOptional(options.idempotencyKey);
    if (!idempotencyKey) {
        throw new RecruitmentGroupServiceError('missing_idempotency_key', 'O lançamento precisa de uma identificação única.');
    }

    await ensureRecruitmentGroupSchema(db);
    await ensurePlayerExists(db, playerId);
    const event = await getEvent(db, options.eventKey || DEFAULT_EVENT_KEY);
    const occurredAt = new Date(options.occurredAt || options.at || new Date());
    if (!isEventActive(event, occurredAt)) {
        throw new RecruitmentGroupServiceError('event_not_active', 'O evento de divulgação não está ativo no momento.');
    }
    const weekKey = options.weekKey || getMondayWeekKey(occurredAt);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const duplicate = await db.get(
            'SELECT * FROM clover_recruitment_group_submissions WHERE idempotency_key = ?',
            [idempotencyKey]
        );
        if (duplicate) {
            if (duplicate.player_id !== playerId) {
                throw new RecruitmentGroupServiceError('idempotency_conflict', 'Essa identificação já pertence a outro player.');
            }
            await db.exec('COMMIT');
            return {
                ok: true,
                duplicate: true,
                submission: duplicate,
                summary: await getGroupPromotionDashboard(db, playerId, { eventKey: event.event_key, weekKey }),
            };
        }

        const totals = await getSubmissionTotals(db, playerId, event.id, weekKey);
        const prEarned = await getLedgerGroupPr(db, playerId, event.id, weekKey);
        const prLimit = Number(event.group_weekly_pr_limit || 20);
        const groupsRemaining = Math.max(0, GROUP_WEEKLY_LIMIT - totals.groupsCredited);
        const prRemaining = roundPr(Math.max(0, prLimit - prEarned));
        const groupsAllowedByPr = Math.max(0, Math.floor((prRemaining + 0.000001) / GROUP_PR_RATE));
        const groupsCredited = Math.min(groupsReported, groupsRemaining, groupsAllowedByPr);
        const groupsExcess = groupsReported - groupsCredited;
        const prAwarded = roundPr(groupsCredited * GROUP_PR_RATE);

        const inserted = await db.run(
            `INSERT INTO clover_recruitment_group_submissions (
                event_id, player_id, week_key, groups_reported, groups_credited, groups_excess,
                pr_rate, pr_awarded, ledger_id, reason, related_id, idempotency_key,
                created_by, created_at, metadata_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
            [
                event.id,
                playerId,
                weekKey,
                groupsReported,
                groupsCredited,
                groupsExcess,
                GROUP_PR_RATE,
                prAwarded,
                normalizeOptional(reason),
                normalizeOptional(options.relatedId),
                idempotencyKey,
                normalizeOptional(createdBy),
                JSON.stringify(options.metadata || {}),
            ]
        );

        let ledger = null;
        if (prAwarded > 0) {
            const ledgerInsert = await db.run(
                `INSERT INTO clover_pr_ledger (
                    player_id, event_id, amount, kind, source, week_key, reason,
                    related_id, idempotency_key, created_by, created_at, metadata_json
                 ) VALUES (?, ?, ?, 'ganho', 'divulgacao_grupo', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
                [
                    playerId,
                    event.id,
                    prAwarded,
                    weekKey,
                    normalizeOptional(reason) || `Divulgação em ${groupsReported} grupos`,
                    normalizeOptional(options.relatedId) || `group_submission:${inserted.lastID}`,
                    `pr:${idempotencyKey}`,
                    normalizeOptional(createdBy),
                    JSON.stringify({
                        ...(options.metadata || {}),
                        group_submission_id: inserted.lastID,
                        groups_reported: groupsReported,
                        groups_credited: groupsCredited,
                        groups_excess: groupsExcess,
                        pr_rate: GROUP_PR_RATE,
                    }),
                ]
            );
            ledger = await db.get('SELECT * FROM clover_pr_ledger WHERE id = ?', [ledgerInsert.lastID]);
            await db.run(
                'UPDATE clover_recruitment_group_submissions SET ledger_id = ? WHERE id = ?',
                [ledger.id, inserted.lastID]
            );
        }

        const submission = await db.get(
            'SELECT * FROM clover_recruitment_group_submissions WHERE id = ?',
            [inserted.lastID]
        );
        await db.exec('COMMIT');
        return {
            ok: true,
            duplicate: false,
            submission,
            ledger,
            summary: await getGroupPromotionDashboard(db, playerId, { eventKey: event.event_key, weekKey }),
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    GROUP_PR_RATE,
    GROUP_WEEKLY_LIMIT,
    RecruitmentGroupServiceError,
    ensureRecruitmentGroupSchema,
    getGroupPromotionDashboard,
    recordGroupPromotion,
    roundPr,
};
