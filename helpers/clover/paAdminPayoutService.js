'use strict';

const crypto = require('crypto');
const {
    ensureCloverAdminServiceSchema,
    ensureCloverQuickEvaluationsSchema,
} = require('../../database');
const {
    WEEKLY_COMMON_PH_LIMIT,
    formatWeekKey,
    normalizeWeekInput,
} = require('./adminService');
const { addPhInTransaction, ensurePhState } = require('./phService');
const { getCanonicalPlayer, isEmptyCharacterPlayer } = require('./targetResolver');

async function resolvePayoutPlayer(db, evaluatorId) {
    const player = await getCanonicalPlayer(db, evaluatorId).catch(() => null);
    if (!player) return { ok: false, code: 'no_player' };
    if (isEmptyCharacterPlayer(player)) return { ok: false, code: 'no_character', player };
    return { ok: true, player };
}

async function readPendingPoints(db, evaluatorId, weekKey = null) {
    const params = [evaluatorId];
    const weekWhere = weekKey ? ' AND service_week_key = ?' : '';
    if (weekKey) params.push(weekKey);
    const row = await db.get(
        `SELECT COALESCE(SUM(points - paid_points), 0) AS pending
         FROM clover_admin_service_entries
         WHERE evaluator_id = ?
           AND status IN ('pending', 'partial')
           AND points > paid_points
           ${weekWhere}`,
        params
    );
    return Math.max(0, Number(row?.pending || 0));
}

async function readCommonPhUsed(db, playerId, weekKey) {
    const quick = await db.get(
        `SELECT COALESCE(SUM(ph_amount), 0) AS total
         FROM clover_quick_evaluations
         WHERE player_id = ?
           AND week_key = ?
           AND bypass_weekly_limit = 0`,
        [playerId, weekKey]
    );
    const payouts = await db.get(
        `SELECT COALESCE(SUM(ph_paid), 0) AS total
         FROM clover_admin_service_payouts
         WHERE player_id = ?
           AND week_key = ?`,
        [playerId, weekKey]
    );
    return Number(quick?.total || 0) + Number(payouts?.total || 0);
}

async function consumePendingPoints(db, evaluatorId, amount, weekKey = null) {
    let remaining = Number(amount || 0);
    const consumed = [];
    const params = [evaluatorId];
    const weekWhere = weekKey ? ' AND service_week_key = ?' : '';
    if (weekKey) params.push(weekKey);

    const entries = await db.all(
        `SELECT id, points, paid_points
         FROM clover_admin_service_entries
         WHERE evaluator_id = ?
           AND status IN ('pending', 'partial')
           AND points > paid_points
           ${weekWhere}
         ORDER BY created_at ASC, id ASC`,
        params
    );

    for (const entry of entries) {
        if (remaining <= 0) break;
        const available = Number(entry.points || 0) - Number(entry.paid_points || 0);
        const used = Math.min(available, remaining);
        const nextPaid = Number(entry.paid_points || 0) + used;
        const nextStatus = nextPaid >= Number(entry.points || 0) ? 'paid' : 'partial';
        await db.run(
            `UPDATE clover_admin_service_entries
             SET paid_points = ?, status = ?
             WHERE id = ?`,
            [nextPaid, nextStatus, entry.id]
        );
        consumed.push({ entryId: entry.id, points: used });
        remaining -= used;
    }

    const total = consumed.reduce((sum, entry) => sum + Number(entry.points || 0), 0);
    if (total !== Number(amount || 0)) {
        const error = new Error('PA consumido não corresponde ao pagamento solicitado.');
        error.code = 'pa_balance_changed';
        throw error;
    }
    return consumed;
}

async function payPaAsPhSafely(db, evaluatorId, {
    createdBy,
    reason = 'Conversão administrativa de PA',
    weekKey = null,
    points = null,
} = {}) {
    await ensureCloverAdminServiceSchema(db);
    await ensureCloverQuickEvaluationsSchema(db);

    const payoutWeekKey = weekKey ? normalizeWeekInput(weekKey) : formatWeekKey(new Date());
    const playerResult = await resolvePayoutPlayer(db, evaluatorId);
    if (!playerResult.ok) return { ...playerResult, weekKey: payoutWeekKey };
    const player = playerResult.player;
    await ensurePhState(db, player.id);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const pendingPoints = await readPendingPoints(db, evaluatorId, weekKey ? payoutWeekKey : null);
        if (pendingPoints <= 0) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'no_pending', player, weekKey: payoutWeekKey };
        }

        const usedThisWeek = await readCommonPhUsed(db, player.id, payoutWeekKey);
        const remainingCap = Math.max(0, WEEKLY_COMMON_PH_LIMIT - usedThisWeek);
        if (remainingCap <= 0) {
            await db.exec('ROLLBACK');
            return {
                ok: false,
                code: 'weekly_cap',
                player,
                weekKey: payoutWeekKey,
                usedThisWeek,
                remainingCap,
            };
        }

        const requested = Number(points || 0);
        const requestedCap = Number.isInteger(requested) && requested > 0 ? requested : pendingPoints;
        const pointsToPay = Math.min(pendingPoints, remainingCap, requestedCap);
        if (pointsToPay <= 0) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'no_pending', player, weekKey: payoutWeekKey };
        }

        const consumed = await consumePendingPoints(
            db,
            evaluatorId,
            pointsToPay,
            weekKey ? payoutWeekKey : null
        );
        const relatedId = `admin_service_safe:${crypto.randomUUID()}`;
        const phResult = await addPhInTransaction(
            db,
            player.id,
            pointsToPay,
            'servico_adm',
            reason,
            createdBy || 'system',
            {
                evaluator_id: evaluatorId,
                week_key: payoutWeekKey,
                service_week_key: weekKey ? payoutWeekKey : null,
                points_paid: pointsToPay,
                consumed_entries: consumed,
                race_safe: true,
            },
            relatedId
        );
        const payout = await db.run(
            `INSERT INTO clover_admin_service_payouts
             (evaluator_id, player_id, points_paid, ph_paid, week_key, source, reason, created_by, ledger_id, metadata_json)
             VALUES (?, ?, ?, ?, ?, 'servico_adm_safe', ?, ?, ?, ?)`,
            [
                evaluatorId,
                player.id,
                pointsToPay,
                pointsToPay,
                payoutWeekKey,
                reason,
                createdBy || null,
                phResult.ledgerId,
                JSON.stringify({
                    used_this_week: usedThisWeek,
                    remaining_cap_before: remainingCap,
                    pending_inside_transaction: pendingPoints,
                    consumed,
                    race_safe: true,
                }),
            ]
        );
        await db.exec('COMMIT');

        return {
            ok: true,
            code: 'paid',
            payoutId: payout.lastID,
            evaluatorId,
            player,
            weekKey: payoutWeekKey,
            pointsPaid: pointsToPay,
            phPaid: pointsToPay,
            usedThisWeek,
            remainingCapBefore: remainingCap,
            pendingInsideTransaction: pendingPoints,
            phResult,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

module.exports = {
    payPaAsPhSafely,
    readCommonPhUsed,
    readPendingPoints,
};