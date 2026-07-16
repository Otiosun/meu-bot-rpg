'use strict';

const crypto = require('crypto');
const {
    ensureCloverAdminServiceSchema,
    ensureCloverQuickEvaluationsSchema,
} = require('../../database');
const { addPhInTransaction, ensurePhState } = require('./phService');
const { formatWeekKey, normalizeWeekInput } = require('./adminService');
const { getPaShopItem } = require('./paShopCatalog');
const { ensureCloverPaShopSchema } = require('./paShopSchema');
const { resolvePaShopPlayer } = require('./paShopService');

const WEEKLY_COMMON_PH_LIMIT = 30;

function asPositiveInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
}

function safeJsonParse(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function normalizeOriginWeek(value, fallback = formatWeekKey(new Date())) {
    const text = String(value || '').trim();
    return text ? normalizeWeekInput(text) : fallback;
}

function getEntryOriginWeek(entry, fallback = formatWeekKey(new Date())) {
    return normalizeOriginWeek(
        entry?.scene_week_key
        || entry?.evaluation_week_key
        || entry?.service_week_key,
        fallback
    );
}

async function ensureSceneWeekDependencies(db) {
    await ensureCloverAdminServiceSchema(db);
    await ensureCloverQuickEvaluationsSchema(db);
    await ensureCloverPaShopSchema(db);
}

async function readPendingPaEntries(db, evaluatorId, { serviceWeekKey = null } = {}) {
    const params = [evaluatorId];
    const serviceFilter = serviceWeekKey ? ' AND s.service_week_key = ?' : '';
    if (serviceWeekKey) params.push(normalizeWeekInput(serviceWeekKey));

    return db.all(
        `SELECT s.id, s.evaluation_id, s.points, s.paid_points, s.status,
                s.service_week_key, s.scene_week_key, s.scene_sent_at,
                s.created_at, q.week_key AS evaluation_week_key
         FROM clover_admin_service_entries s
         LEFT JOIN clover_quick_evaluations q ON q.id = s.evaluation_id
         WHERE s.evaluator_id = ?
           AND s.status IN ('pending', 'partial')
           AND s.points > s.paid_points
           ${serviceFilter}
         ORDER BY s.created_at ASC, s.id ASC`,
        params
    );
}

async function readCommonPhUsed(db, playerId, weekKey) {
    const normalizedWeek = normalizeWeekInput(weekKey);
    const quick = await db.get(
        `SELECT COALESCE(SUM(ph_amount), 0) AS total
         FROM clover_quick_evaluations
         WHERE player_id = ?
           AND week_key = ?
           AND bypass_weekly_limit = 0
           AND COALESCE(json_extract(metadata_json, '$.voided_by_correction'), 0) != 1
           AND COALESCE(json_extract(rewards_json, '$.cap'), '') != 'anulado'`,
        [playerId, normalizedWeek]
    );
    const payouts = await db.get(
        `SELECT COALESCE(SUM(ph_paid), 0) AS total
         FROM clover_admin_service_payouts
         WHERE player_id = ?
           AND week_key = ?`,
        [playerId, normalizedWeek]
    );
    return Number(quick?.total || 0) + Number(payouts?.total || 0);
}

async function getPaOriginSummary(db, evaluatorId, playerId, { serviceWeekKey = null } = {}) {
    await ensureSceneWeekDependencies(db);
    const entries = await readPendingPaEntries(db, evaluatorId, { serviceWeekKey });
    const byWeek = new Map();

    for (const entry of entries) {
        const weekKey = getEntryOriginWeek(entry);
        const pendingPa = Math.max(0, Number(entry.points || 0) - Number(entry.paid_points || 0));
        if (!pendingPa) continue;
        const current = byWeek.get(weekKey) || {
            weekKey,
            pendingPa: 0,
            entryCount: 0,
            firstEntryAt: entry.created_at || null,
        };
        current.pendingPa += pendingPa;
        current.entryCount += 1;
        byWeek.set(weekKey, current);
    }

    const buckets = [];
    for (const bucket of byWeek.values()) {
        const usedPh = playerId ? await readCommonPhUsed(db, playerId, bucket.weekKey) : 0;
        const remainingCap = playerId ? Math.max(0, WEEKLY_COMMON_PH_LIMIT - usedPh) : 0;
        buckets.push({
            ...bucket,
            usedPh,
            remainingCap,
            purchasablePh: Math.min(bucket.pendingPa, remainingCap),
            blockedPa: Math.max(0, bucket.pendingPa - remainingCap),
        });
    }

    buckets.sort((left, right) => (
        String(left.firstEntryAt || '').localeCompare(String(right.firstEntryAt || ''))
        || left.weekKey.localeCompare(right.weekKey)
    ));

    return {
        evaluatorId,
        playerId,
        serviceWeekKey: serviceWeekKey ? normalizeWeekInput(serviceWeekKey) : null,
        buckets,
        pendingPa: buckets.reduce((sum, bucket) => sum + bucket.pendingPa, 0),
        purchasablePh: buckets.reduce((sum, bucket) => sum + bucket.purchasablePh, 0),
        blockedPa: buckets.reduce((sum, bucket) => sum + bucket.blockedPa, 0),
    };
}

async function allocatePendingPaBySceneWeek(db, evaluatorId, playerId, requestedAmount, { serviceWeekKey = null } = {}) {
    const requested = asPositiveInteger(requestedAmount);
    if (!requested) return { ok: false, code: 'invalid_amount', requested: requestedAmount };

    const entries = await readPendingPaEntries(db, evaluatorId, { serviceWeekKey });
    const usedByWeek = new Map();
    const allocatedByWeek = new Map();
    let remaining = requested;

    for (const entry of entries) {
        if (remaining <= 0) break;
        const weekKey = getEntryOriginWeek(entry);
        if (!usedByWeek.has(weekKey)) usedByWeek.set(weekKey, await readCommonPhUsed(db, playerId, weekKey));

        const alreadyAllocated = Number(allocatedByWeek.get(weekKey)?.points || 0);
        const room = Math.max(0, WEEKLY_COMMON_PH_LIMIT - Number(usedByWeek.get(weekKey) || 0) - alreadyAllocated);
        if (room <= 0) continue;

        const availableOnEntry = Math.max(0, Number(entry.points || 0) - Number(entry.paid_points || 0));
        const used = Math.min(availableOnEntry, room, remaining);
        if (used <= 0) continue;

        const nextPaid = Number(entry.paid_points || 0) + used;
        const nextStatus = nextPaid >= Number(entry.points || 0) ? 'paid' : 'partial';
        await db.run(
            `UPDATE clover_admin_service_entries
             SET paid_points = ?, status = ?
             WHERE id = ?`,
            [nextPaid, nextStatus, entry.id]
        );

        const bucket = allocatedByWeek.get(weekKey) || {
            weekKey,
            points: 0,
            usedBefore: Number(usedByWeek.get(weekKey) || 0),
            entries: [],
        };
        bucket.points += used;
        bucket.entries.push({
            entryId: entry.id,
            points: used,
            serviceWeekKey: entry.service_week_key || null,
            sceneWeekKey: entry.scene_week_key || entry.evaluation_week_key || null,
        });
        allocatedByWeek.set(weekKey, bucket);
        remaining -= used;
    }

    const allocations = [...allocatedByWeek.values()].map((bucket) => ({
        ...bucket,
        usedAfter: bucket.usedBefore + bucket.points,
        remainingCapAfter: Math.max(0, WEEKLY_COMMON_PH_LIMIT - bucket.usedBefore - bucket.points),
    }));

    if (remaining > 0) {
        return {
            ok: false,
            code: 'weekly_ph_limit',
            requested,
            available: requested - remaining,
            remaining,
            allocations,
        };
    }

    return {
        ok: true,
        requested,
        allocations,
        consumed: allocations.flatMap((bucket) => bucket.entries),
    };
}

async function insertPhAllocationPayouts(db, {
    evaluatorId,
    player,
    allocations,
    source,
    reason,
    createdBy,
    relatedPrefix,
    purchaseId = null,
}) {
    const applied = [];

    for (const allocation of allocations) {
        const relatedId = `${relatedPrefix}:${allocation.weekKey}`;
        const metadata = {
            purchase_id: purchaseId,
            origin_week_key: allocation.weekKey,
            used_before: allocation.usedBefore,
            remaining_cap_after: allocation.remainingCapAfter,
            consumed_entries: allocation.entries,
            scene_week_attribution: true,
        };
        const phResult = await addPhInTransaction(
            db,
            player.id,
            allocation.points,
            source === 'pa_shop_ph' ? 'pa_shop' : source,
            reason,
            createdBy,
            metadata,
            relatedId
        );
        const payout = await db.run(
            `INSERT INTO clover_admin_service_payouts
             (evaluator_id, player_id, points_paid, ph_paid, week_key, source,
              reason, created_by, ledger_id, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                evaluatorId,
                player.id,
                allocation.points,
                allocation.points,
                allocation.weekKey,
                source,
                reason,
                createdBy || evaluatorId,
                phResult.ledgerId,
                JSON.stringify(metadata),
            ]
        );
        applied.push({ ...allocation, ledgerId: phResult.ledgerId, payoutId: payout.lastID, phResult });
    }

    return applied;
}

async function purchasePhBySceneWeek(db, evaluatorId, {
    quantity,
    createdBy = evaluatorId,
    idempotencyKey = null,
    purchaseWeekKey = formatWeekKey(new Date()),
} = {}) {
    await ensureSceneWeekDependencies(db);
    const item = getPaShopItem('ph');
    const requestedQuantity = asPositiveInteger(quantity);
    if (!requestedQuantity) return { ok: false, code: 'quantity_required', item };

    const playerResult = await resolvePaShopPlayer(db, evaluatorId);
    if (!playerResult.ok) return { ok: false, code: playerResult.code, item, player: playerResult.player || null };
    const player = playerResult.player;
    await ensurePhState(db, player.id);

    if (idempotencyKey) {
        const existing = await db.get('SELECT * FROM clover_pa_shop_purchases WHERE idempotency_key = ?', [idempotencyKey]);
        if (existing) return { ok: false, code: 'duplicate', item, purchase: existing };
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        if (idempotencyKey) {
            const duplicate = await db.get('SELECT * FROM clover_pa_shop_purchases WHERE idempotency_key = ?', [idempotencyKey]);
            if (duplicate) {
                await db.exec('ROLLBACK');
                return { ok: false, code: 'duplicate', item, purchase: duplicate };
            }
        }

        const originBefore = await getPaOriginSummary(db, evaluatorId, player.id);
        if (originBefore.pendingPa < requestedQuantity) {
            await db.exec('ROLLBACK');
            return {
                ok: false,
                code: 'insufficient_pa',
                item,
                availablePa: originBefore.pendingPa,
                paCost: requestedQuantity,
                originSummary: originBefore,
            };
        }

        const allocation = await allocatePendingPaBySceneWeek(db, evaluatorId, player.id, requestedQuantity);
        if (!allocation.ok) {
            await db.exec('ROLLBACK');
            return { ...allocation, item, originSummary: originBefore };
        }

        const purchaseInsert = await db.run(
            `INSERT INTO clover_pa_shop_purchases
             (evaluator_id, player_id, item_key, quantity, unit_pa_cost, pa_cost,
              reward_json, week_key, status, source, idempotency_key, created_by,
              reason, metadata_json)
             VALUES (?, ?, 'ph', ?, 1, ?, '{}', ?, 'completed', 'pa_shop', ?, ?, ?, ?)`,
            [
                evaluatorId,
                player.id,
                requestedQuantity,
                requestedQuantity,
                normalizeWeekInput(purchaseWeekKey),
                idempotencyKey || null,
                createdBy || evaluatorId,
                'Compra: PH de serviço',
                JSON.stringify({ origin_allocations: allocation.allocations, scene_week_attribution: true }),
            ]
        );
        const purchaseId = purchaseInsert.lastID;
        const applied = await insertPhAllocationPayouts(db, {
            evaluatorId,
            player,
            allocations: allocation.allocations,
            source: 'pa_shop_ph',
            reason: 'PH comprado na Loja de PA',
            createdBy: createdBy || evaluatorId,
            relatedPrefix: `pa_shop:${purchaseId}`,
            purchaseId,
        });

        const reward = {
            type: 'ph',
            amount: requestedQuantity,
            allocations: applied.map((entry) => ({
                weekKey: entry.weekKey,
                amount: entry.points,
                usedBefore: entry.usedBefore,
                usedAfter: entry.usedAfter,
                remainingCapAfter: entry.remainingCapAfter,
                ledgerId: entry.ledgerId,
                payoutId: entry.payoutId,
            })),
        };

        await db.run(
            `UPDATE clover_pa_shop_purchases
             SET reward_json = ?, metadata_json = ?
             WHERE id = ?`,
            [
                JSON.stringify(reward),
                JSON.stringify({ origin_allocations: allocation.allocations, reward, scene_week_attribution: true }),
                purchaseId,
            ]
        );

        await db.exec('COMMIT');
        return {
            ok: true,
            code: 'purchased',
            evaluatorId,
            player,
            item,
            quantity: requestedQuantity,
            paCost: requestedQuantity,
            purchaseId,
            weekKey: normalizeWeekInput(purchaseWeekKey),
            reward,
            originAllocations: reward.allocations,
            availablePaBefore: originBefore.pendingPa,
            availablePaAfter: originBefore.pendingPa - requestedQuantity,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        if (error?.code === 'SQLITE_CONSTRAINT' && idempotencyKey) {
            const existing = await db.get('SELECT * FROM clover_pa_shop_purchases WHERE idempotency_key = ?', [idempotencyKey]).catch(() => null);
            if (existing) return { ok: false, code: 'duplicate', item, purchase: existing };
        }
        throw error;
    }
}

async function payPaBySceneWeek(db, evaluatorId, {
    createdBy,
    reason = 'Conversão administrativa de PA',
    weekKey = null,
    points = null,
} = {}) {
    await ensureSceneWeekDependencies(db);
    const serviceWeekKey = weekKey ? normalizeWeekInput(weekKey) : null;
    const playerResult = await resolvePaShopPlayer(db, evaluatorId);
    if (!playerResult.ok) return { ...playerResult, serviceWeekKey };

    const player = playerResult.player;
    await ensurePhState(db, player.id);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const summary = await getPaOriginSummary(db, evaluatorId, player.id, { serviceWeekKey });
        if (summary.pendingPa <= 0) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'no_pending', player, serviceWeekKey, originSummary: summary };
        }

        const requested = asPositiveInteger(points);
        const requestedCap = requested || summary.pendingPa;
        const pointsToPay = Math.min(requestedCap, summary.purchasablePh);
        if (pointsToPay <= 0) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'weekly_cap', player, serviceWeekKey, originSummary: summary };
        }

        const allocation = await allocatePendingPaBySceneWeek(db, evaluatorId, player.id, pointsToPay, { serviceWeekKey });
        if (!allocation.ok) {
            await db.exec('ROLLBACK');
            return { ...allocation, player, serviceWeekKey, originSummary: summary };
        }

        const payoutGroupId = `admin_service_safe:${crypto.randomUUID()}`;
        const applied = await insertPhAllocationPayouts(db, {
            evaluatorId,
            player,
            allocations: allocation.allocations,
            source: 'servico_adm_safe',
            reason,
            createdBy: createdBy || 'system',
            relatedPrefix: payoutGroupId,
        });

        await db.exec('COMMIT');
        return {
            ok: true,
            code: 'paid',
            evaluatorId,
            player,
            serviceWeekKey,
            payoutWeekKey: applied.length === 1 ? applied[0].weekKey : 'múltiplas semanas',
            allocations: applied.map((entry) => ({
                weekKey: entry.weekKey,
                amount: entry.points,
                usedBefore: entry.usedBefore,
                usedAfter: entry.usedAfter,
                remainingCapAfter: entry.remainingCapAfter,
                payoutId: entry.payoutId,
                ledgerId: entry.ledgerId,
            })),
            pointsPaid: pointsToPay,
            phPaid: pointsToPay,
            requestedPoints: requested || null,
            pendingInsideTransaction: summary.pendingPa,
            partialByCap: pointsToPay < requestedCap,
            usedThisWeek: applied.length === 1 ? applied[0].usedBefore : null,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function readConsumedEntriesForPayout(db, payout) {
    const metadata = safeJsonParse(payout.metadata_json, {});
    const raw = Array.isArray(metadata.consumed_entries)
        ? metadata.consumed_entries
        : Array.isArray(metadata.consumed)
            ? metadata.consumed
            : [];
    const ids = [...new Set(raw
        .map((item) => Number(item?.entryId || item?.entry_id || 0))
        .filter((id) => Number.isInteger(id) && id > 0))];
    if (!ids.length) return [];

    const placeholders = ids.map(() => '?').join(',');
    const rows = await db.all(
        `SELECT s.id, s.points, s.paid_points, s.service_week_key, s.scene_week_key,
                q.week_key AS evaluation_week_key
         FROM clover_admin_service_entries s
         LEFT JOIN clover_quick_evaluations q ON q.id = s.evaluation_id
         WHERE s.id IN (${placeholders})`,
        ids
    );
    const byId = new Map(rows.map((row) => [Number(row.id), row]));

    return raw.map((item) => {
        const entryId = Number(item?.entryId || item?.entry_id || 0);
        const row = byId.get(entryId);
        return {
            entryId,
            points: Number(item?.points || 0),
            expectedWeekKey: row ? getEntryOriginWeek(row, payout.week_key) : payout.week_key,
            serviceWeekKey: row?.service_week_key || null,
            sceneWeekKey: row?.scene_week_key || row?.evaluation_week_key || null,
        };
    }).filter((item) => item.entryId > 0 && item.points > 0);
}

async function auditPaSceneWeeks(db, { evaluatorId = null, limit = 50 } = {}) {
    await ensureSceneWeekDependencies(db);
    const params = [];
    const evaluatorWhere = evaluatorId ? ' AND p.evaluator_id = ?' : '';
    if (evaluatorId) params.push(evaluatorId);
    params.push(Math.max(1, Math.min(200, Number(limit) || 50)));

    const payouts = await db.all(
        `SELECT p.*
         FROM clover_admin_service_payouts p
         WHERE p.points_paid > 0
           AND p.ph_paid > 0
           ${evaluatorWhere}
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT ?`,
        params
    );

    const mismatches = [];
    for (const payout of payouts) {
        const consumed = await readConsumedEntriesForPayout(db, payout);
        if (!consumed.length) continue;

        const expectedByWeek = new Map();
        for (const item of consumed) {
            expectedByWeek.set(item.expectedWeekKey, Number(expectedByWeek.get(item.expectedWeekKey) || 0) + item.points);
        }
        const wrongAmount = consumed
            .filter((item) => item.expectedWeekKey !== payout.week_key)
            .reduce((sum, item) => sum + item.points, 0);
        if (!wrongAmount) continue;

        mismatches.push({
            payoutId: payout.id,
            evaluatorId: payout.evaluator_id,
            playerId: payout.player_id,
            source: payout.source,
            recordedWeekKey: payout.week_key,
            phPaid: Number(payout.ph_paid || 0),
            wrongAmount,
            expected: [...expectedByWeek.entries()].map(([weekKey, amount]) => ({ weekKey, amount })),
            consumed,
            createdAt: payout.created_at,
        });
    }

    let pending = [];
    if (evaluatorId) {
        const playerResult = await resolvePaShopPlayer(db, evaluatorId);
        pending = playerResult.ok ? (await getPaOriginSummary(db, evaluatorId, playerResult.player.id)).buckets : [];
    } else {
        const evaluators = await db.all(
            `SELECT DISTINCT evaluator_id
             FROM clover_admin_service_entries
             WHERE status IN ('pending', 'partial')
               AND points > paid_points`
        );
        for (const row of evaluators) {
            const playerResult = await resolvePaShopPlayer(db, row.evaluator_id);
            if (!playerResult.ok) continue;
            const summary = await getPaOriginSummary(db, row.evaluator_id, playerResult.player.id);
            pending.push(...summary.buckets.map((bucket) => ({ evaluatorId: row.evaluator_id, ...bucket })));
        }
    }

    return {
        evaluatorId,
        checkedPayouts: payouts.length,
        mismatchCount: mismatches.length,
        wrongPh: mismatches.reduce((sum, item) => sum + item.wrongAmount, 0),
        mismatches,
        pending,
        applyAutomatically: false,
    };
}

module.exports = {
    WEEKLY_COMMON_PH_LIMIT,
    allocatePendingPaBySceneWeek,
    auditPaSceneWeeks,
    getEntryOriginWeek,
    getPaOriginSummary,
    payPaBySceneWeek,
    purchasePhBySceneWeek,
    readCommonPhUsed,
    readPendingPaEntries,
};