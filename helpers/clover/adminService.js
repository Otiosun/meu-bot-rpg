const {
    ensureCloverAdminServiceSchema,
    ensureCloverQuickEvaluationsSchema,
} = require('../../database');
const { addPhInTransaction, ensurePhState } = require('./phService');
const {
    getCanonicalPlayer,
    isEmptyCharacterPlayer,
} = require('./targetResolver');

const WEEKLY_COMMON_PH_LIMIT = 30;

const SERVICE_WEIGHTS = {
    treino_solo: { weight: 1, points: 2 },
    cena_vinculo: { weight: 1, points: 2 },
    missao_auto_narrada: { weight: 1, points: 2 },
    diario: { weight: 1, points: 2 },
    cena_interativa: { weight: 2, points: 4 },
    treino_duo: { weight: 2, points: 4 },
    cena_consequencia: { weight: 2, points: 4 },
    spin_off: { weight: 3, points: 6 },
    missao_desenvolvimento: { weight: 4, points: 8 },
    missao: { weight: 4, points: 8 },
    evento: { weight: 4, points: 8 },
};

function pad2(value) {
    return String(value).padStart(2, '0');
}

function parseSqliteDate(value) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? new Date() : value;
    const text = String(value || '').trim();
    if (!text) return new Date();
    const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) {
        return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12, 0, 0);
    }
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(text)) {
        const [datePart, timePart] = text.split(' ');
        const [year, month, day] = datePart.split('-').map(Number);
        const [hour, minute, second = 0] = timePart.split(':').map(Number);
        return new Date(year, month - 1, day, hour, minute, second);
    }
    const parsed = new Date(text.replace(' ', 'T'));
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function formatWeekKey(date = new Date()) {
    const start = parseSqliteDate(date);
    start.setHours(0, 0, 0, 0);
    const daysSinceMonday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - daysSinceMonday);
    return `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`;
}

function normalizeWeekInput(value) {
    const text = String(value || '').trim();
    if (!text) return formatWeekKey(new Date());
    const br = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (br) {
        const year = Number(br[3].length === 2 ? `20${br[3]}` : br[3]);
        return formatWeekKey(new Date(year, Number(br[2]) - 1, Number(br[1]), 12, 0, 0));
    }
    return formatWeekKey(text);
}

function getServiceRule(modalityKey) {
    return SERVICE_WEIGHTS[String(modalityKey || '').trim()] || null;
}

async function resolveServiceEvaluatorId(db, evaluatorId) {
    const raw = String(evaluatorId || '').trim();
    if (!raw) return '';
    const player = await getCanonicalPlayer(db, raw).catch(() => null);
    return String(player?.id || raw).trim();
}

async function recordEvaluationService(db, {
    evaluatorId,
    evaluationId,
    targetPlayerId = null,
    modalityKey,
    modalityLabel,
    sceneWeekKey = null,
    sceneSentAt = null,
    evaluatedAt = null,
    chatId = null,
    metadata = {},
}) {
    await ensureCloverAdminServiceSchema(db);

    const rule = getServiceRule(modalityKey);
    if (!rule || !evaluatorId || !evaluationId) {
        return { ok: false, skipped: true, reason: 'unsupported_modality' };
    }

    const serviceEvaluatorId = await resolveServiceEvaluatorId(db, evaluatorId);
    const serviceWeekKey = formatWeekKey(evaluatedAt || new Date());
    const result = await db.run(
        `INSERT OR IGNORE INTO clover_admin_service_entries
         (evaluator_id, evaluation_id, target_player_id, modality_key, modality_label,
          weight, points, paid_points, status, source, service_week_key, scene_week_key,
          scene_sent_at, evaluated_at, created_by, reason, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending', 'quick_evaluation', ?, ?, ?, ?, ?, ?, ?)`,
        [
            serviceEvaluatorId,
            evaluationId,
            targetPlayerId,
            modalityKey,
            modalityLabel,
            rule.weight,
            rule.points,
            serviceWeekKey,
            sceneWeekKey,
            sceneSentAt,
            evaluatedAt,
            serviceEvaluatorId,
            `Avaliacao aprovada: ${modalityLabel}`,
            JSON.stringify({ ...(metadata || {}), chat_id: chatId || null, original_evaluator_id: evaluatorId }),
        ]
    );

    return {
        ok: true,
        inserted: Number(result?.changes || 0) > 0,
        evaluatorId: serviceEvaluatorId,
        weight: rule.weight,
        points: rule.points,
        serviceWeekKey,
    };
}

// Contract reviews earn service points in the same existing payroll ledger.
// The caller owns the mission approval transaction. Never synthesize a numeric
// quick-evaluation ID, or apply PH directly to the evaluator.
async function recordMissionServiceInTransaction(db, { missionKey, playerId, evaluatorId, mode, countsForSalary }) {
    if (countsForSalary !== true) return { ok: true, skipped: true, reason: 'mission_salary_disabled' };
    if (!missionKey || !playerId || !evaluatorId || playerId === evaluatorId || !['official','auto_narrated'].includes(mode))
        throw new Error('Origem de serviço de missão inválida.');
    await ensureCloverAdminServiceSchema(db);
    await db.exec(
        'CREATE TABLE IF NOT EXISTS clover_mission_service_links (' +
        'mission_key TEXT NOT NULL, player_id TEXT NOT NULL, service_entry_id INTEGER NOT NULL UNIQUE,' +
        'PRIMARY KEY(mission_key,player_id),' +
        'FOREIGN KEY(mission_key,player_id) REFERENCES clover_mission_payout_receipts(mission_key,player_id),' +
        'FOREIGN KEY(service_entry_id) REFERENCES clover_admin_service_entries(id))'
    );
    const receipt = await db.get(
        'SELECT reviewed_by,paid_at FROM clover_mission_payout_receipts WHERE mission_key=? AND player_id=?',
        [missionKey,playerId]
    );
    if (!receipt || receipt.reviewed_by !== evaluatorId) throw new Error('Recibo de missão incompatível com o serviço ADM.');
    const modalityKey = mode === 'auto_narrated' ? 'missao_auto_narrada' : 'missao';
    const modalityLabel = mode === 'auto_narrated' ? 'Missão Auto-Narrada' : 'Missão Oficial';
    const rule = getServiceRule(modalityKey);
    const serviceEvaluatorId = await resolveServiceEvaluatorId(db,evaluatorId);
    if (serviceEvaluatorId === playerId) throw new Error('Autoavaliação não pode gerar serviço ADM.');
    const existing = await db.get(
        'SELECT s.* FROM clover_mission_service_links l JOIN clover_admin_service_entries s ON s.id=l.service_entry_id WHERE l.mission_key=? AND l.player_id=?',
        [missionKey,playerId]
    );
    if (existing) {
        if (existing.evaluator_id !== serviceEvaluatorId || existing.target_player_id !== playerId ||
            existing.modality_key !== modalityKey || existing.source !== 'mission_contract')
            throw new Error('Vínculo de serviço ADM inconsistente.');
        return { ok: true, duplicate: true, entryId: existing.id, points: existing.points };
    }
    // SQLite timestamps are UTC; retain the payroll's existing local-week convention.
    const evaluatedAt = String(receipt.paid_at).replace(' ','T') + 'Z';
    const serviceWeekKey = formatWeekKey(evaluatedAt);
    const inserted = await db.run(
        "INSERT INTO clover_admin_service_entries (evaluator_id,evaluation_id,target_player_id,modality_key,modality_label,weight,points,paid_points,status,source,service_week_key,evaluated_at,created_by,reason,metadata_json) VALUES (?,NULL,?,?,?,?,?,0,'pending','mission_contract',?,?,?,?,?)",
        [serviceEvaluatorId,playerId,modalityKey,modalityLabel,rule.weight,rule.points,serviceWeekKey,
            receipt.paid_at,serviceEvaluatorId,'Avaliação de missão: '+missionKey,
            JSON.stringify({mission_key:missionKey,original_evaluator_id:evaluatorId})]
    );
    await db.run('INSERT INTO clover_mission_service_links (mission_key,player_id,service_entry_id) VALUES (?,?,?)',
        [missionKey,playerId,inserted.lastID]);
    return { ok: true, duplicate: false, entryId: inserted.lastID, points: rule.points, serviceWeekKey };
}

async function syncExistingEvaluations(db, { weekKey = null } = {}) {
    await ensureCloverAdminServiceSchema(db);
    await ensureCloverQuickEvaluationsSchema(db);

    const params = [];
    let where = '1 = 1';
    if (weekKey) {
        where += ' AND q.week_key = ?';
        params.push(weekKey);
    }

    const rows = await db.all(
        `SELECT q.*
         FROM clover_quick_evaluations q
         LEFT JOIN clover_admin_service_entries s ON s.evaluation_id = q.id
         WHERE ${where}
           AND s.id IS NULL
         ORDER BY q.id ASC`,
        params
    );

    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
        const result = await recordEvaluationService(db, {
            evaluatorId: row.evaluator_id,
            evaluationId: row.id,
            targetPlayerId: row.player_id,
            modalityKey: row.modality_key,
            modalityLabel: row.modality_label,
            sceneWeekKey: row.week_key,
            sceneSentAt: row.scene_sent_at,
            evaluatedAt: row.evaluated_at || row.created_at,
            chatId: row.chat_id,
            metadata: { source: 'manual_sync' },
        });
        if (result.inserted) inserted += 1;
        else skipped += 1;
    }

    return { ok: true, checked: rows.length, inserted, skipped };
}

async function getServiceSummary(db, evaluatorId, { weekKey = null } = {}) {
    await ensureCloverAdminServiceSchema(db);
    const params = [evaluatorId];
    let weekWhere = '';
    if (weekKey) {
        weekWhere = ' AND service_week_key = ?';
        params.push(weekKey);
    }
    const row = await db.get(
        `SELECT
             COALESCE(SUM(CASE WHEN status <> 'void' THEN points ELSE 0 END), 0) AS earned_points,
             COALESCE(SUM(CASE WHEN status IN ('pending', 'partial') AND points > paid_points THEN points - paid_points ELSE 0 END), 0) AS pending_points,
             COALESCE(SUM(CASE WHEN status <> 'void' THEN paid_points ELSE 0 END), 0) AS settled_points,
             COUNT(CASE WHEN source IN ('quick_evaluation','mission_contract') AND status <> 'void' THEN 1 END) AS evaluations
         FROM clover_admin_service_entries
         WHERE evaluator_id = ?
         ${weekWhere}`,
        params
    );

    const payoutParams = [evaluatorId];
    let payoutWeekWhere = '';
    if (weekKey) {
        payoutWeekWhere = ' AND week_key = ?';
        payoutParams.push(weekKey);
    }
    const payout = await db.get(
        `SELECT COALESCE(SUM(points_paid), 0) AS points_paid,
                COALESCE(SUM(ph_paid), 0) AS ph_paid
         FROM clover_admin_service_payouts
         WHERE evaluator_id = ?
         ${payoutWeekWhere}`,
        payoutParams
    );

    return {
        evaluatorId,
        earnedPoints: Number(row?.earned_points || 0),
        pendingPoints: Math.max(0, Number(row?.pending_points || 0)),
        settledPoints: Number(row?.settled_points || 0),
        evaluations: Number(row?.evaluations || 0),
        pointsPaid: Number(payout?.points_paid || 0),
        phPaid: Number(payout?.ph_paid || 0),
    };
}

async function listRecentServiceEntries(db, evaluatorId, limit = 8) {
    await ensureCloverAdminServiceSchema(db);
    return db.all(
        `SELECT *
         FROM clover_admin_service_entries
         WHERE evaluator_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [evaluatorId, Math.max(1, Math.min(20, Number(limit) || 8))]
    );
}

async function listServiceWeeks(db, evaluatorId, { limit = 8 } = {}) {
    await ensureCloverAdminServiceSchema(db);
    const rows = await db.all(
        `SELECT
             service_week_key AS week_key,
             COALESCE(SUM(CASE WHEN status <> 'void' THEN points ELSE 0 END), 0) AS earned_points,
             COALESCE(SUM(CASE WHEN status IN ('pending', 'partial') AND points > paid_points THEN points - paid_points ELSE 0 END), 0) AS pending_points,
             COALESCE(SUM(CASE WHEN status <> 'void' THEN paid_points ELSE 0 END), 0) AS settled_points,
             COUNT(CASE WHEN source IN ('quick_evaluation','mission_contract') AND status <> 'void' THEN 1 END) AS evaluations
         FROM clover_admin_service_entries
         WHERE evaluator_id = ?
         GROUP BY service_week_key
         ORDER BY service_week_key DESC
         LIMIT ?`,
        [evaluatorId, Math.max(1, Math.min(16, Number(limit) || 8))]
    );

    const payouts = await db.all(
        `SELECT week_key,
                COALESCE(SUM(points_paid), 0) AS points_paid,
                COALESCE(SUM(ph_paid), 0) AS ph_paid
         FROM clover_admin_service_payouts
         WHERE evaluator_id = ?
         GROUP BY week_key`,
        [evaluatorId]
    );
    const payoutByWeek = new Map(payouts.map((row) => [row.week_key, row]));

    return rows.map((row) => {
        const payout = payoutByWeek.get(row.week_key) || {};
        return {
            weekKey: row.week_key || '-',
            earnedPoints: Number(row.earned_points || 0),
            pendingPoints: Number(row.pending_points || 0),
            settledPoints: Number(row.settled_points || 0),
            evaluations: Number(row.evaluations || 0),
            pointsPaid: Number(payout.points_paid || 0),
            phPaid: Number(payout.ph_paid || 0),
        };
    });
}

async function getWeeklyServiceRanking(db, weekKey = formatWeekKey(new Date())) {
    await ensureCloverAdminServiceSchema(db);
    return db.all(
        `SELECT evaluator_id,
                COALESCE(SUM(points), 0) AS points,
                COUNT(CASE WHEN source IN ('quick_evaluation','mission_contract') THEN 1 END) AS evaluations
         FROM clover_admin_service_entries
         WHERE service_week_key = ?
           AND status <> 'void'
         GROUP BY evaluator_id
         HAVING points <> 0 OR evaluations > 0
         ORDER BY points DESC, evaluations DESC, evaluator_id ASC`,
        [weekKey]
    );
}

async function getEvaluatorsWithPending(db) {
    await ensureCloverAdminServiceSchema(db);
    return db.all(
        `SELECT evaluator_id,
                COALESCE(SUM(CASE WHEN points > paid_points THEN points - paid_points ELSE 0 END), 0) AS pending_points
         FROM clover_admin_service_entries
         WHERE status IN ('pending', 'partial')
         GROUP BY evaluator_id
         HAVING pending_points > 0
         ORDER BY pending_points DESC, evaluator_id ASC`
    );
}

async function getEvaluatorPendingWeeks(db, evaluatorId) {
    await ensureCloverAdminServiceSchema(db);
    return db.all(
        `SELECT service_week_key AS week_key,
                COALESCE(SUM(points - paid_points), 0) AS pending_points
         FROM clover_admin_service_entries
         WHERE evaluator_id = ?
           AND status IN ('pending', 'partial')
           AND points > paid_points
         GROUP BY service_week_key
         HAVING pending_points > 0
         ORDER BY service_week_key ASC`,
        [evaluatorId]
    );
}

async function getCommonPhUsedThisWeek(db, playerId, weekKey) {
    await ensureCloverAdminServiceSchema(db);
    await ensureCloverQuickEvaluationsSchema(db);
    const quick = await db.get(
        `SELECT COALESCE(SUM(ph_amount), 0) AS total
         FROM clover_quick_evaluations
         WHERE player_id = ?
           AND week_key = ?
           AND bypass_weekly_limit = 0`,
        [playerId, weekKey]
    );
    const salary = await db.get(
        `SELECT COALESCE(SUM(ph_paid), 0) AS total
         FROM clover_admin_service_payouts
         WHERE player_id = ?
           AND week_key = ?`,
        [playerId, weekKey]
    );
    return Number(quick?.total || 0) + Number(salary?.total || 0);
}

async function resolvePayoutPlayer(db, evaluatorId) {
    const player = await getCanonicalPlayer(db, evaluatorId).catch(() => null);
    if (!player) return { ok: false, reason: 'no_player' };
    if (isEmptyCharacterPlayer(player)) return { ok: false, reason: 'no_character', player };
    return { ok: true, player };
}

async function consumePendingPoints(db, evaluatorId, pointsToConsume, { weekKey = null } = {}) {
    let remaining = Number(pointsToConsume || 0);
    const consumed = [];
    if (remaining <= 0) return consumed;

    const params = [evaluatorId];
    let weekWhere = '';
    if (weekKey) {
        weekWhere = ' AND service_week_key = ?';
        params.push(weekKey);
    }
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
        const status = nextPaid >= Number(entry.points || 0) ? 'paid' : 'partial';
        await db.run(
            `UPDATE clover_admin_service_entries
             SET paid_points = ?,
                 status = ?
             WHERE id = ?`,
            [nextPaid, status, entry.id]
        );
        consumed.push({ id: entry.id, points: used });
        remaining -= used;
    }

    return consumed;
}

async function payService(db, evaluatorId, {
    createdBy,
    reason = 'Pagamento de servico ADM',
    weekKey = null,
    points = null,
} = {}) {
    await ensureCloverAdminServiceSchema(db);
    const payoutWeekKey = weekKey ? normalizeWeekInput(weekKey) : formatWeekKey(new Date());
    const summary = await getServiceSummary(db, evaluatorId, weekKey ? { weekKey: payoutWeekKey } : {});
    if (summary.pendingPoints <= 0) {
        return { ok: false, code: 'no_pending', summary, weekKey: payoutWeekKey };
    }

    const payoutPlayer = await resolvePayoutPlayer(db, evaluatorId);
    if (!payoutPlayer.ok) {
        return { ok: false, code: payoutPlayer.reason, summary, player: payoutPlayer.player || null };
    }

    const player = payoutPlayer.player;
    const usedThisWeek = await getCommonPhUsedThisWeek(db, player.id, payoutWeekKey);
    const remainingCap = Math.max(0, WEEKLY_COMMON_PH_LIMIT - usedThisWeek);
    if (remainingCap <= 0) {
        return { ok: false, code: 'weekly_cap', summary, player, weekKey: payoutWeekKey, usedThisWeek, remainingCap };
    }

    const requested = Number(points || 0);
    const requestedCap = Number.isInteger(requested) && requested > 0 ? requested : summary.pendingPoints;
    const pointsToPay = Math.min(summary.pendingPoints, remainingCap, requestedCap);
    await ensurePhState(db, player.id);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const consumed = await consumePendingPoints(db, evaluatorId, pointsToPay, weekKey ? { weekKey: payoutWeekKey } : {});
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
            },
            `admin_service:${evaluatorId}:${Date.now()}`
        );
        const payout = await db.run(
            `INSERT INTO clover_admin_service_payouts
             (evaluator_id, player_id, points_paid, ph_paid, week_key, source, reason, created_by, ledger_id, metadata_json)
             VALUES (?, ?, ?, ?, ?, 'servico_adm', ?, ?, ?, ?)`,
            [
                evaluatorId,
                player.id,
                pointsToPay,
                pointsToPay,
                payoutWeekKey,
                reason,
                createdBy || null,
                phResult.ledgerId,
                JSON.stringify({ used_this_week: usedThisWeek, remaining_cap_before: remainingCap, consumed }),
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
            phResult,
        };
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

async function addManualServicePoints(db, evaluatorId, {
    points,
    createdBy,
    reason,
    source = 'manual_bonus',
}) {
    await ensureCloverAdminServiceSchema(db);
    const value = Number(points);
    if (!Number.isInteger(value) || value === 0) {
        return { ok: false, code: 'invalid_points' };
    }

    if (value > 0) {
        const result = await db.run(
            `INSERT INTO clover_admin_service_entries
             (evaluator_id, modality_key, modality_label, weight, points, paid_points, status,
              source, service_week_key, created_by, reason, metadata_json)
             VALUES (?, 'manual', 'Ajuste manual', 0, ?, 0, 'pending', ?, ?, ?, ?, ?)`,
            [
                evaluatorId,
                value,
                source,
                formatWeekKey(new Date()),
                createdBy || null,
                reason || 'Ajuste manual de servico ADM',
                JSON.stringify({ manual: true }),
            ]
        );
        return { ok: true, code: 'added', entryId: result.lastID, points: value };
    }

    let remaining = Math.abs(value);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const consumed = await consumePendingPoints(db, evaluatorId, remaining);
        const deducted = consumed.reduce((sum, item) => sum + Number(item.points || 0), 0);
        if (deducted <= 0) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'no_pending' };
        }
        const audit = await db.run(
            `INSERT INTO clover_admin_service_entries
             (evaluator_id, modality_key, modality_label, weight, points, paid_points, status,
              source, service_week_key, created_by, reason, metadata_json)
             VALUES (?, 'manual', 'Ajuste manual', 0, ?, ?, 'paid', ?, ?, ?, ?, ?)`,
            [
                evaluatorId,
                -deducted,
                -deducted,
                source,
                formatWeekKey(new Date()),
                createdBy || null,
                reason || 'Ajuste manual de servico ADM',
                JSON.stringify({ manual: true, requested: value, consumed }),
            ]
        );
        await db.exec('COMMIT');
        return { ok: true, code: 'deducted', entryId: audit.lastID, points: -deducted, requested: value };
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

module.exports = {
    SERVICE_WEIGHTS,
    WEEKLY_COMMON_PH_LIMIT,
    addManualServicePoints,
    formatWeekKey,
    getCommonPhUsedThisWeek,
    getEvaluatorPendingWeeks,
    getEvaluatorsWithPending,
    getServiceSummary,
    getServiceRule,
    getWeeklyServiceRanking,
    listServiceWeeks,
    listRecentServiceEntries,
    normalizeWeekInput,
    payService,
    recordEvaluationService,
    recordMissionServiceInTransaction,
    resolveServiceEvaluatorId,
    syncExistingEvaluations,
};
