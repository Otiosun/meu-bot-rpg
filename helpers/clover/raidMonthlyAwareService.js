'use strict';

const v2 = require('./raidV2Service');
const {
    RaidMonthlyProgressError,
    completeRaidProgressInTransaction,
    ensureRaidMonthlyProgressSchema,
    releaseParticipantProgressInTransaction,
    releaseRaidProgressInTransaction,
    reserveParticipantInTransaction,
} = require('./raidMonthlyProgressService');

function asRaidServiceError(error) {
    if (error instanceof v2.RaidServiceError) return error;
    if (error instanceof RaidMonthlyProgressError || error?.code) {
        return new v2.RaidServiceError(
            error.code || 'raid_monthly_progress_failed',
            error.message || 'Não foi possível atualizar o progresso mensal da raid.',
            error.details || {}
        );
    }
    return error;
}

async function raidRow(db, raidKey) {
    await v2.ensureRaidV2Schema(db);
    const key = String(raidKey || '').trim();
    const row = await db.get(
        `SELECT * FROM clover_raids
         WHERE raid_key = ? OR CAST(id AS TEXT) = ?`,
        [key.toUpperCase(), key]
    );
    if (!row) throw new v2.RaidServiceError('raid_not_found', 'Raid não encontrada.');
    return row;
}

async function participantRow(db, raidId, playerId) {
    return db.get(
        `SELECT * FROM clover_raid_participants
         WHERE raid_id = ? AND player_id = ?`,
        [raidId, String(playerId)]
    );
}

async function joinRaid(db, raidKey, playerId, options = {}) {
    await ensureRaidMonthlyProgressSchema(db);
    const result = await v2.joinRaid(db, raidKey, playerId, options);
    const raid = await raidRow(db, raidKey);
    const canonicalPlayerId = result.participant?.playerId || String(playerId);
    const participant = await participantRow(db, raid.id, canonicalPlayerId);
    if (!participant) return result;

    try {
        await db.exec('BEGIN IMMEDIATE');
        const monthlyReservation = await reserveParticipantInTransaction(
            db,
            raid,
            participant,
            canonicalPlayerId
        );
        await db.exec('COMMIT');
        return { ...result, monthlyReservation };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        if (!result.duplicate) {
            await v2.leaveRaid(db, raidKey, canonicalPlayerId).catch(() => null);
        }
        throw asRaidServiceError(error);
    }
}

async function leaveRaid(db, raidKey, playerId) {
    await ensureRaidMonthlyProgressSchema(db);
    const raid = await raidRow(db, raidKey);
    const current = await participantRow(db, raid.id, playerId);
    const canonicalPlayerId = current?.player_id || String(playerId);
    const result = await v2.leaveRaid(db, raidKey, canonicalPlayerId);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const progress = await releaseParticipantProgressInTransaction(
            db,
            raid,
            canonicalPlayerId,
            canonicalPlayerId,
            'participant_left'
        );
        await db.exec('COMMIT');
        return { ...result, monthlyProgress: progress };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw asRaidServiceError(error);
    }
}

async function removeRaidParticipant(db, raidKey, actorId, targetPlayerId, reason = null) {
    await ensureRaidMonthlyProgressSchema(db);
    const raid = await raidRow(db, raidKey);
    const current = await participantRow(db, raid.id, targetPlayerId);
    const canonicalTargetId = current?.player_id || String(targetPlayerId);
    const result = await v2.removeRaidParticipant(
        db,
        raidKey,
        actorId,
        canonicalTargetId,
        reason
    );
    await db.exec('BEGIN IMMEDIATE');
    try {
        const progress = await releaseParticipantProgressInTransaction(
            db,
            raid,
            canonicalTargetId,
            actorId,
            'participant_removed'
        );
        await db.exec('COMMIT');
        return { ...result, monthlyProgress: progress };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw asRaidServiceError(error);
    }
}

async function cancelRaid(db, raidKey, actorId, reason) {
    await ensureRaidMonthlyProgressSchema(db);
    const raid = await raidRow(db, raidKey);
    const result = await v2.cancelRaid(db, raidKey, actorId, reason);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const progress = await releaseRaidProgressInTransaction(
            db,
            raid,
            actorId,
            'raid_cancelled'
        );
        await db.exec('COMMIT');
        return { ...result, monthlyProgress: progress };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw asRaidServiceError(error);
    }
}

async function completeRaid(db, raidKey, actorId, options = {}) {
    await ensureRaidMonthlyProgressSchema(db);
    const before = await raidRow(db, raidKey);
    const participants = await db.all(
        `SELECT * FROM clover_raid_participants
         WHERE raid_id = ? AND status = 'active'
         ORDER BY id ASC`,
        [before.id]
    );
    const result = await v2.completeRaid(db, raidKey, actorId, options);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const progress = await completeRaidProgressInTransaction(
            db,
            before,
            participants,
            actorId
        );
        await db.exec('COMMIT');
        const updated = await raidRow(db, raidKey);
        return {
            ...result,
            raid: await v2.serializeRaidV2(db, updated),
            monthlyProgress: progress,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw new v2.RaidServiceError(
            'raid_completed_progress_pending',
            'A raid foi concluída, mas o progresso mensal ainda precisa ser sincronizado. Repita a conclusão com a mesma chave.',
            {
                raidKey: before.raid_key,
                cause: error?.code || error?.message || 'unknown_progress_error',
            }
        );
    }
}

module.exports = {
    ...v2,
    cancelRaid,
    completeRaid,
    joinRaid,
    leaveRaid,
    removeRaidParticipant,
};