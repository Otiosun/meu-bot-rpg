'use strict';

const crypto = require('crypto');
const { ensurePaShopDependencies } = require('./paShopService');
const { formatWeekKey } = require('./adminService');
const {
    appendReturnPointsInTransaction,
    getReturnPointsBalance,
} = require('./returnPointsService');

const PA_RETURN_RESET_POLICY_VERSION = 'PA_RETURN_1TO1_RESET_V1';
const PA_RETURN_RESET_RATE = Object.freeze({ numerator: 1, denominator: 1 });
const PA_RETURN_ITEM_KEY = 'return_points_reset_conversion';

function hash(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function required(value, label) {
    const text = String(value || '').trim();
    if (!text) throw new Error(`${label} obrigatorio.`);
    return text;
}

function operationKey(campaignKey, playerId) {
    return `pa-return-reset:${hash(`${campaignKey}:${playerId}`).slice(0, 40)}`;
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

async function readPendingPaRows(db, evaluatorId) {
    return db.all(
        `SELECT id, points, paid_points, status, service_week_key, scene_week_key, created_at
         FROM clover_admin_service_entries
         WHERE evaluator_id = ?
           AND status IN ('pending', 'partial')
           AND points > paid_points
         ORDER BY created_at ASC, id ASC`,
        [evaluatorId]
    );
}

function availableFromRows(rows) {
    return (rows || []).reduce(
        (sum, row) => sum + Math.max(0, Number(row.points || 0) - Number(row.paid_points || 0)),
        0
    );
}

function rowsDigest(rows) {
    return hash(JSON.stringify((rows || []).map((row) => ({
        id: Number(row.id),
        points: Number(row.points || 0),
        paid_points: Number(row.paid_points || 0),
        status: row.status || null,
        service_week_key: row.service_week_key || null,
        scene_week_key: row.scene_week_key || null,
        created_at: row.created_at || null,
    }))));
}

async function existingClaim(db, claimKey) {
    return db.get(
        `SELECT * FROM clover_pa_shop_purchases
         WHERE idempotency_key = ? AND source = 'prereset_pa_return_conversion'`,
        [claimKey]
    );
}

async function duplicateResult(db, player, cycle, row) {
    const reward = safeJsonParse(row?.reward_json, {});
    return Object.freeze({
        ok: true,
        duplicate: true,
        policyVersion: PA_RETURN_RESET_POLICY_VERSION,
        resetCycleKey: cycle,
        rate: PA_RETURN_RESET_RATE,
        sourcePaAvailable: Number(row?.pa_cost || reward.amount || 0),
        calculatedReturnPoints: Number(reward.amount || row?.pa_cost || 0),
        purchase: row,
        returnPointsBalance: await getReturnPointsBalance(db, player),
    });
}

/**
 * System-only RESET conversion.
 *
 * PA authority is the unspent remainder of clover_admin_service_entries.
 * Conversion consumes that remainder by advancing paid_points/status, credits
 * exactly the same integer amount as Return Points, and persists an idempotent
 * audit row. KEEP players never call this service from the launch path.
 */
async function convertPaToReturnForReset(db, playerId, campaignKey, actorId) {
    const player = required(playerId, 'playerId');
    const cycle = required(campaignKey, 'campaignKey');
    const actor = required(actorId, 'actorId');
    const claimKey = operationKey(cycle, player);

    await ensurePaShopDependencies(db);

    const existing = await existingClaim(db, claimKey);
    if (existing) return duplicateResult(db, player, cycle, existing);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const replay = await existingClaim(db, claimKey);
        if (replay) {
            await db.exec('COMMIT');
            return duplicateResult(db, player, cycle, replay);
        }

        const rows = await readPendingPaRows(db, player);
        const amount = availableFromRows(rows);
        if (!Number.isInteger(amount) || amount < 0) {
            const error = new Error(`PA authority invalida para ${player}.`);
            error.code = 'invalid_pa_authority';
            throw error;
        }

        if (amount === 0) {
            await db.exec('COMMIT');
            return Object.freeze({
                ok: true,
                duplicate: false,
                policyVersion: PA_RETURN_RESET_POLICY_VERSION,
                resetCycleKey: cycle,
                rate: PA_RETURN_RESET_RATE,
                sourcePaAvailable: 0,
                calculatedReturnPoints: 0,
                purchase: null,
                ledger: null,
                returnPointsBalance: await getReturnPointsBalance(db, player),
            });
        }

        const digest = rowsDigest(rows);
        const consumed = [];
        for (const row of rows) {
            const available = Math.max(0, Number(row.points || 0) - Number(row.paid_points || 0));
            if (!available) continue;
            const result = await db.run(
                `UPDATE clover_admin_service_entries
                 SET paid_points = points, status = 'paid'
                 WHERE id = ?
                   AND evaluator_id = ?
                   AND status IN ('pending', 'partial')
                   AND points > paid_points`,
                [row.id, player]
            );
            if (Number(result?.changes || 0) !== 1) {
                const error = new Error('Saldo de PA mudou durante a conversao.');
                error.code = 'pa_source_changed';
                throw error;
            }
            consumed.push({ entryId: Number(row.id), points: available });
        }

        const consumedTotal = consumed.reduce((sum, entry) => sum + entry.points, 0);
        if (consumedTotal !== amount) {
            const error = new Error('Total consumido de PA divergiu do snapshot.');
            error.code = 'pa_source_changed';
            throw error;
        }

        const ledger = await appendReturnPointsInTransaction(db, player, {
            amount,
            entryKind: 'credit',
            operationKey: claimKey,
            source: 'pa_reset_conversion',
            reason: 'Conversao automatica 1:1 de PA legado para Pontos de Retorno antes do reset.',
            policyVersion: PA_RETURN_RESET_POLICY_VERSION,
            resetCycleKey: cycle,
            relatedId: digest,
            correlationId: claimKey,
            createdBy: actor,
            metadata: {
                automatic: true,
                rate: '1:1',
                source_pa_available: amount,
                source_pa_entry_count: rows.length,
                source_pa_digest: digest,
                consumed_entries: consumed,
                pa_consumption: 'paid_points_advanced_to_points',
            },
        });

        const reward = {
            type: 'return_points',
            amount,
            ledgerId: ledger.ledgerId,
        };
        const inserted = await db.run(
            `INSERT INTO clover_pa_shop_purchases
             (evaluator_id, player_id, item_key, quantity, unit_pa_cost, pa_cost,
              reward_json, week_key, status, source, idempotency_key, created_by,
              reason, metadata_json)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'completed',
                     'prereset_pa_return_conversion', ?, ?, ?, ?)`,
            [
                player,
                player,
                PA_RETURN_ITEM_KEY,
                amount,
                amount,
                JSON.stringify(reward),
                formatWeekKey(new Date()),
                claimKey,
                actor,
                'Conversao automatica 1:1 de PA para Pontos de Retorno no reset.',
                JSON.stringify({
                    automatic: true,
                    reset_cycle_key: cycle,
                    policy_version: PA_RETURN_RESET_POLICY_VERSION,
                    rate: '1:1',
                    source_pa_digest: digest,
                    source_pa_entry_count: rows.length,
                    consumed_entries: consumed,
                }),
            ]
        );
        const purchase = await db.get(
            'SELECT * FROM clover_pa_shop_purchases WHERE id = ?',
            [inserted.lastID]
        );

        await db.exec('COMMIT');
        return Object.freeze({
            ok: true,
            duplicate: false,
            policyVersion: PA_RETURN_RESET_POLICY_VERSION,
            resetCycleKey: cycle,
            rate: PA_RETURN_RESET_RATE,
            sourcePaAvailable: amount,
            calculatedReturnPoints: amount,
            purchase,
            ledger,
            returnPointsBalance: await getReturnPointsBalance(db, player),
        });
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

module.exports = {
    PA_RETURN_ITEM_KEY,
    PA_RETURN_RESET_POLICY_VERSION,
    PA_RETURN_RESET_RATE,
    availableFromRows,
    convertPaToReturnForReset,
    operationKey,
    readPendingPaRows,
    rowsDigest,
};