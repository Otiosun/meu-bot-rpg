'use strict';

const crypto = require('crypto');
const { getPhLedgerAuthoritySnapshot } = require('./phService');
const {
    appendReturnPointsInTransaction,
    getReturnPointsBalance,
} = require('./returnPointsService');

const PH_RETURN_RESET_POLICY_VERSION = 'PH_RETURN_1TO1_RESET_V1';
const PH_RETURN_RESET_RATE = Object.freeze({ numerator: 1, denominator: 1 });

function hash(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function required(value, label) {
    const text = String(value || '').trim();
    if (!text) throw new Error(`${label} obrigatorio.`);
    return text;
}

function operationKey(campaignKey, playerId) {
    return `ph-return-reset:${hash(`${campaignKey}:${playerId}`).slice(0, 40)}`;
}

/**
 * System-only launch conversion.
 *
 * The reset path deletes clover_ph_ledger afterwards. Therefore this service
 * snapshots PH authority, credits exactly the available PH as Return Points,
 * and records the conversion claim before resetPlayer() destroys legacy PH.
 * It never exposes a player-triggered claim path.
 */
async function convertPhToReturnForReset(db, playerId, campaignKey, actorId) {
    const player = required(playerId, 'playerId');
    const cycle = required(campaignKey, 'campaignKey');
    const actor = required(actorId, 'actorId');

    const existing = await db.get(
        `SELECT * FROM clover_return_point_conversion_claims
         WHERE player_id = ? AND policy_version = ? AND reset_cycle_key = ?`,
        [player, PH_RETURN_RESET_POLICY_VERSION, cycle]
    );
    if (existing) {
        return Object.freeze({
            ok: true,
            duplicate: true,
            policyVersion: PH_RETURN_RESET_POLICY_VERSION,
            resetCycleKey: cycle,
            rate: PH_RETURN_RESET_RATE,
            sourcePhAvailable: Number(existing.source_ph_available || 0),
            calculatedReturnPoints: Number(existing.calculated_return_points || 0),
            claim: existing,
            returnPointsBalance: await getReturnPointsBalance(db, player),
        });
    }

    const snapshot = await getPhLedgerAuthoritySnapshot(db, player);
    const amount = Number(snapshot.available || 0);
    if (!Number.isInteger(amount) || amount < 0) {
        throw new Error(`PH authority invalida para ${player}.`);
    }
    const claimKey = operationKey(cycle, player);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const replay = await db.get(
            `SELECT * FROM clover_return_point_conversion_claims
             WHERE player_id = ? AND policy_version = ? AND reset_cycle_key = ?`,
            [player, PH_RETURN_RESET_POLICY_VERSION, cycle]
        );
        if (replay) {
            await db.exec('COMMIT');
            return Object.freeze({
                ok: true,
                duplicate: true,
                policyVersion: PH_RETURN_RESET_POLICY_VERSION,
                resetCycleKey: cycle,
                rate: PH_RETURN_RESET_RATE,
                sourcePhAvailable: Number(replay.source_ph_available || 0),
                calculatedReturnPoints: Number(replay.calculated_return_points || 0),
                claim: replay,
                returnPointsBalance: await getReturnPointsBalance(db, player),
            });
        }

        let ledger = null;
        if (amount > 0) {
            ledger = await appendReturnPointsInTransaction(db, player, {
                amount,
                entryKind: 'credit',
                operationKey: claimKey,
                source: 'ph_reset_conversion',
                reason: 'Conversao automatica 1:1 de PH legado para Pontos de Retorno antes do reset.',
                policyVersion: PH_RETURN_RESET_POLICY_VERSION,
                resetCycleKey: cycle,
                relatedId: snapshot.ledgerDigest,
                correlationId: claimKey,
                createdBy: actor,
                metadata: {
                    automatic: true,
                    rate: '1:1',
                    source_ph_available: amount,
                    source_ph_accumulated: snapshot.accumulated,
                    source_ph_entry_count: snapshot.entryCount,
                    ph_consumption: 'legacy_ph_deleted_by_character_reset',
                },
            });
        }

        const inserted = await db.run(
            `INSERT INTO clover_return_point_conversion_claims
             (player_id, policy_version, reset_cycle_key, claim_key, source_ph_ledger_digest,
              source_ph_available, calculated_return_points, status, return_points_ledger_id, claimed_at, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'claimed', ?, CURRENT_TIMESTAMP, ?)`,
            [
                player,
                PH_RETURN_RESET_POLICY_VERSION,
                cycle,
                claimKey,
                snapshot.ledgerDigest,
                amount,
                amount,
                ledger?.ledgerId || null,
                JSON.stringify({
                    automatic: true,
                    rate: '1:1',
                    source_ph_accumulated: snapshot.accumulated,
                    source_ph_entry_count: snapshot.entryCount,
                    ph_consumption: 'legacy_ph_deleted_by_character_reset',
                }),
            ]
        );
        const claim = await db.get(
            'SELECT * FROM clover_return_point_conversion_claims WHERE id = ?',
            [inserted.lastID]
        );
        await db.exec('COMMIT');
        return Object.freeze({
            ok: true,
            duplicate: false,
            policyVersion: PH_RETURN_RESET_POLICY_VERSION,
            resetCycleKey: cycle,
            rate: PH_RETURN_RESET_RATE,
            sourcePhAvailable: amount,
            calculatedReturnPoints: amount,
            claim,
            ledger,
            returnPointsBalance: await getReturnPointsBalance(db, player),
        });
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

module.exports = {
    PH_RETURN_RESET_POLICY_VERSION,
    PH_RETURN_RESET_RATE,
    convertPhToReturnForReset,
    operationKey,
};
