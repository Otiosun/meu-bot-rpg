'use strict';

const { ensureCloverRecruitmentSchema } = require('../../database');
const {
    DEFAULT_EVENT_KEY,
    PrServiceError,
    getEvent,
    getMondayWeekKey,
    getPrSummary,
    mutatePrInTransaction,
} = require('./prService');

const PR_TENTHS_PER_GROUP = 4;
const MAX_PAID_GROUPS_PER_WEEK = 50;

function normalizeOptional(value) {
    const text = String(value || '').trim();
    return text || null;
}

function serializeMetadata(value) {
    if (!value || typeof value !== 'object') return null;
    return JSON.stringify(value);
}

function positiveInteger(value, label = 'Quantidade de grupos') {
    const amount = Number(value);
    if (!Number.isInteger(amount) || amount <= 0) {
        throw new PrServiceError('invalid_group_count', `${label} precisa ser um número inteiro positivo.`);
    }
    return amount;
}

function parseEventDate(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const normalized = text.includes('T') ? text : text.replace(' ', 'T');
    const parsed = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function eventIsActive(event, at = new Date()) {
    const current = new Date(at);
    if (Number.isNaN(current.getTime()) || event.status !== 'active') return false;
    const startsAt = parseEventDate(event.starts_at);
    const endsAt = parseEventDate(event.ends_at);
    return (!startsAt || current >= startsAt) && (!endsAt || current <= endsAt);
}

async function ensureGroupPromotionSchema(db) {
    await ensureCloverRecruitmentSchema(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_recruitment_group_submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            week_key TEXT NOT NULL,
            groups_reported INTEGER NOT NULL,
            groups_paid INTEGER NOT NULL DEFAULT 0,
            pr_tenths INTEGER NOT NULL DEFAULT 0,
            reason TEXT DEFAULT NULL,
            related_id TEXT DEFAULT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            created_by TEXT DEFAULT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL,
            FOREIGN KEY (event_id) REFERENCES clover_recruitment_events(id),
            FOREIGN KEY (player_id) REFERENCES jogadores(id)
        );
        CREATE INDEX IF NOT EXISTS idx_clover_group_submissions_player_week
            ON clover_recruitment_group_submissions(player_id, event_id, week_key, id);
    `);
}

function paidGroupCap(event) {
    const prLimitTenths = Math.max(0, Math.round(Number(event.group_weekly_pr_limit || 0) * 10));
    const byConfiguredPrLimit = Math.floor(prLimitTenths / PR_TENTHS_PER_GROUP);
    return Math.min(MAX_PAID_GROUPS_PER_WEEK, byConfiguredPrLimit);
}

async function readGroupWeekTotals(db, playerId, eventId, weekKey) {
    const row = await db.get(
        `SELECT
            COALESCE(SUM(groups_reported), 0) AS groups_reported,
            COALESCE(SUM(groups_paid), 0) AS groups_paid,
            COALESCE(SUM(pr_tenths), 0) AS pr_tenths,
            COUNT(*) AS submissions
         FROM clover_recruitment_group_submissions
         WHERE player_id = ? AND event_id = ? AND week_key = ?`,
        [playerId, eventId, weekKey]
    );
    return {
        groupsReported: Number(row?.groups_reported || 0),
        groupsPaid: Number(row?.groups_paid || 0),
        prTenths: Number(row?.pr_tenths || 0),
        submissions: Number(row?.submissions || 0),
    };
}

function serializeGroupSummary(event, weekKey, totals) {
    const groupCap = paidGroupCap(event);
    const groupsReported = Number(totals.groupsReported || 0);
    const groupsPaid = Number(totals.groupsPaid || 0);
    const prTenths = Number(totals.prTenths || 0);
    return {
        weekKey,
        groupsReported,
        groupsPaid,
        groupsUnpaid: Math.max(0, groupsReported - groupsPaid),
        bonusEligibleGroups: Math.max(0, groupsReported - MAX_PAID_GROUPS_PER_WEEK),
        paidGroupCap: groupCap,
        remainingPaidGroups: Math.max(0, groupCap - groupsPaid),
        prEarned: prTenths / 10,
        prLimit: Number(event.group_weekly_pr_limit || 0),
        submissions: Number(totals.submissions || 0),
    };
}

async function getGroupPromotionWeekSummary(db, playerId, options = {}) {
    await ensureGroupPromotionSchema(db);
    const event = await getEvent(db, options.eventKey || DEFAULT_EVENT_KEY);
    const weekKey = options.weekKey || getMondayWeekKey(options.at || new Date());
    const totals = await readGroupWeekTotals(db, playerId, event.id, weekKey);
    return serializeGroupSummary(event, weekKey, totals);
}

async function getGroupPromotionHistory(db, playerId, limit = 20) {
    await ensureGroupPromotionSchema(db);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    return db.all(
        `SELECT *
         FROM clover_recruitment_group_submissions
         WHERE player_id = ?
         ORDER BY id DESC
         LIMIT ?`,
        [playerId, safeLimit]
    );
}

async function grantGroupPromotionByCount(db, playerId, groupCount, reason, createdBy, options = {}) {
    const groupsReported = positiveInteger(groupCount);
    const idempotencyKey = normalizeOptional(options.idempotencyKey);
    if (!idempotencyKey) {
        throw new PrServiceError('missing_idempotency_key', 'O lançamento de grupos precisa de uma identificação única.');
    }

    await ensureGroupPromotionSchema(db);
    const eventKey = options.eventKey || DEFAULT_EVENT_KEY;
    const weekKey = options.weekKey || getMondayWeekKey(options.occurredAt || new Date());
    const occurredAt = new Date(options.occurredAt || Date.now());

    await db.exec('BEGIN IMMEDIATE');
    try {
        const duplicate = await db.get(
            'SELECT * FROM clover_recruitment_group_submissions WHERE idempotency_key = ?',
            [idempotencyKey]
        );
        if (duplicate) {
            if (duplicate.player_id !== playerId) {
                throw new PrServiceError('idempotency_conflict', 'Esse lançamento já pertence a outro player.');
            }
            const duplicateEvent = await db.get(
                'SELECT * FROM clover_recruitment_events WHERE id = ?',
                [duplicate.event_id]
            );
            const totals = await readGroupWeekTotals(db, playerId, duplicate.event_id, duplicate.week_key);
            await db.exec('COMMIT');
            return {
                ok: true,
                duplicate: true,
                submission: duplicate,
                groupsReported: Number(duplicate.groups_reported),
                groupsPaid: Number(duplicate.groups_paid),
                groupsUnpaid: Math.max(0, Number(duplicate.groups_reported) - Number(duplicate.groups_paid)),
                prAwarded: Number(duplicate.pr_tenths) / 10,
                groupSummary: serializeGroupSummary(duplicateEvent, duplicate.week_key, totals),
                prSummary: await getPrSummary(db, playerId, { eventKey: duplicateEvent.event_key, weekKey: duplicate.week_key }),
            };
        }

        const player = await db.get('SELECT id, jogo_status FROM jogadores WHERE id = ?', [playerId]);
        if (!player) throw new PrServiceError('player_not_found', 'Player não encontrado.');
        if (String(player.jogo_status || '').trim().toLowerCase() !== 'liberado') {
            throw new PrServiceError('game_not_released', 'O personagem ainda não está liberado para receber PR.');
        }

        const event = await getEvent(db, eventKey);
        if (!eventIsActive(event, occurredAt)) {
            throw new PrServiceError('event_not_active', 'O evento de divulgação não está ativo no momento.', {
                eventStatus: event.status,
            });
        }

        const before = await readGroupWeekTotals(db, playerId, event.id, weekKey);
        const groupCap = paidGroupCap(event);
        const remainingPaidGroups = Math.max(0, groupCap - before.groupsPaid);
        const groupsPaid = Math.min(groupsReported, remainingPaidGroups);
        const groupsUnpaid = Math.max(0, groupsReported - groupsPaid);
        const prTenths = groupsPaid * PR_TENTHS_PER_GROUP;
        const prAwarded = prTenths / 10;

        const inserted = await db.run(
            `INSERT INTO clover_recruitment_group_submissions (
                event_id, player_id, week_key, groups_reported, groups_paid, pr_tenths,
                reason, related_id, idempotency_key, created_by, metadata_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                event.id,
                playerId,
                weekKey,
                groupsReported,
                groupsPaid,
                prTenths,
                normalizeOptional(reason) || 'Comprovação de divulgação em grupos aprovada.',
                normalizeOptional(options.relatedId),
                idempotencyKey,
                normalizeOptional(createdBy),
                serializeMetadata({
                    ...(options.metadata || {}),
                    groups_reported: groupsReported,
                    groups_paid: groupsPaid,
                    groups_unpaid: groupsUnpaid,
                    pr_tenths: prTenths,
                    paid_group_cap: groupCap,
                }),
            ]
        );
        const submission = await db.get(
            'SELECT * FROM clover_recruitment_group_submissions WHERE id = ?',
            [inserted.lastID]
        );

        let prMutation = null;
        if (prAwarded > 0) {
            prMutation = await mutatePrInTransaction(db, playerId, {
                amount: prAwarded,
                kind: 'ganho',
                source: 'divulgacao_grupo',
                reason: normalizeOptional(reason) || `${groupsPaid} grupos aprovados.`,
                createdBy,
                eventKey,
                weekKey,
                occurredAt,
                relatedId: options.relatedId || `group_submission:${submission.id}`,
                idempotencyKey: options.prIdempotencyKey || `pr:${idempotencyKey}`,
                metadata: {
                    ...(options.metadata || {}),
                    group_submission_id: submission.id,
                    groups_reported: groupsReported,
                    groups_paid: groupsPaid,
                    groups_unpaid: groupsUnpaid,
                    pr_tenths: prTenths,
                },
            });
        }

        const after = await readGroupWeekTotals(db, playerId, event.id, weekKey);
        const prSummary = await getPrSummary(db, playerId, { eventKey, weekKey });
        await db.exec('COMMIT');

        return {
            ok: true,
            duplicate: false,
            submission,
            groupsReported,
            groupsPaid,
            groupsUnpaid,
            prAwarded,
            prMutation,
            groupSummary: serializeGroupSummary(event, weekKey, after),
            prSummary,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    MAX_PAID_GROUPS_PER_WEEK,
    PR_TENTHS_PER_GROUP,
    ensureGroupPromotionSchema,
    eventIsActive,
    getGroupPromotionHistory,
    getGroupPromotionWeekSummary,
    grantGroupPromotionByCount,
    paidGroupCap,
};
