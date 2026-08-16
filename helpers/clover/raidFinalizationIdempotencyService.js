'use strict';

const { isSameUser, normalizeJid } = require('../groupAccess');
const raidService = require('./raidService');
const { runClaimedRaidMutation } = require('./raidClaimedMutationIdempotency');

function safeJsonParse(value, fallback = null) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function mutationKey(input = {}) {
    return String(input.idempotencyKey || input.idempotency_key || '').trim();
}

async function getRaidRow(db, raidKey) {
    await raidService.ensureRaidV2Schema(db);
    const key = String(raidKey || '').trim();
    const raid = await db.get(
        `SELECT * FROM clover_raids
         WHERE raid_key = ? OR CAST(id AS TEXT) = ?`,
        [key.toUpperCase(), key]
    );
    if (!raid) throw new raidService.RaidServiceError('raid_not_found', 'Raid não encontrada.');
    return raid;
}

async function recoverParticipantFinalization(db, options = {}) {
    const events = await db.all(
        `SELECT * FROM clover_raid_events
         WHERE raid_id = ?
           AND action = 'participant_finalization_reviewed'
           AND actor_id = ?
           AND created_at >= ?
         ORDER BY id DESC
         LIMIT 20`,
        [options.raidId, options.actorId, options.claim.created_at]
    );
    const event = events.find((row) => {
        if (!isSameUser(row.subject_player_id, options.targetPlayerId)) return false;
        const after = safeJsonParse(row.after_json, null);
        return after
            && String(after.status || '') === options.status
            && String(after.note || '') === String(options.note || '');
    });
    if (!event) return null;

    const participant = await db.get(
        `SELECT * FROM clover_raid_participants
         WHERE raid_id = ? AND player_id = ? AND status = 'active'
         ORDER BY id DESC LIMIT 1`,
        [options.raidId, options.targetPlayerId]
    );
    if (!participant) return null;
    if (String(participant.finalization_status || 'pending') !== options.status) return null;
    if (String(participant.finalization_note || '') !== String(options.note || '')) return null;

    return {
        ok: true,
        participant: {
            playerId: options.targetPlayerId,
            finalizationStatus: options.status,
            finalizationNote: options.note,
        },
    };
}

async function setRaidParticipantFinalizationIdempotent(
    db,
    raidKey,
    actorId,
    targetPlayerId,
    input = {}
) {
    const idempotencyKey = mutationKey(input);
    if (!idempotencyKey) {
        return raidService.setRaidParticipantFinalization(
            db,
            raidKey,
            actorId,
            targetPlayerId,
            input
        );
    }

    const raid = await getRaidRow(db, raidKey);
    const actor = normalizeJid(actorId) || String(actorId || '').trim();
    const target = normalizeJid(targetPlayerId) || String(targetPlayerId || '').trim();
    const status = String(input.status || input.finalizationStatus || '').trim().toLowerCase();
    const note = String(input.note || input.reason || input.motivo || '').trim() || null;
    const payload = {
        raidKey: raid.raid_key,
        actorId: actor,
        targetPlayerId: target,
        status,
        note,
    };

    const result = await runClaimedRaidMutation(db, {
        operation: 'review_raid_participant_finalization',
        input: { idempotencyKey },
        payload,
        actorId: actor,
        subjectPlayerId: target,
        raidId: Number(raid.id),
        errorFactory: (code, message, details = {}) => (
            new raidService.RaidServiceError(code, message, details)
        ),
        recover: ({ claim }) => recoverParticipantFinalization(db, {
            claim,
            raidId: Number(raid.id),
            actorId: actor,
            targetPlayerId: target,
            status,
            note,
        }),
        execute: () => raidService.setRaidParticipantFinalization(
            db,
            raidKey,
            actorId,
            targetPlayerId,
            input
        ),
    });

    if (result?.finalization) return result;
    return {
        ...result,
        finalization: await raidService.getRaidFinalizationSummary(db, raidKey, actorId),
    };
}

module.exports = {
    recoverParticipantFinalization,
    setRaidParticipantFinalizationIdempotent,
};
