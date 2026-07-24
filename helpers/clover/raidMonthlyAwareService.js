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

function transactionWithProgress(db, before, participants, actorId, state) {
    return new Proxy(db, {
        get(target, property, receiver) {
            if (property === 'exec') {
                return async (sql, ...args) => {
                    const command = String(sql || '')
                        .trim()
                        .replace(/;+$/, '')
                        .toUpperCase();
                    if (command === 'COMMIT' && !state.applied) {
                        state.progress = await completeRaidProgressInTransaction(
                            target,
                            before,
                            participants,
                            actorId
                        );
                        state.applied = true;
                    }
                    return target.exec(sql, ...args);
                };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
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

async function repairCompletedProgress(db, before, participants, actorId) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        const progress = await completeRaidProgressInTransaction(
            db,
            before,
            participants,
            actorId
        );
        await db.exec('COMMIT');
        return progress;
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
         WHERE raid_id = ? AND status IN ('active', 'completed')
         ORDER BY id ASC`,
        [before.id]
    );

    if (before.status === 'completed') {
        const duplicate = await v2.completeRaid(db, raidKey, actorId, options);
        const progress = await repairCompletedProgress(
            db,
            before,
            participants,
            actorId
        );
        const updated = await raidRow(db, raidKey);
        return {
            ...duplicate,
            raid: await v2.serializeRaidV2(db, updated),
            monthlyProgress: progress,
        };
    }

    const state = { applied: false, progress: null };
    const transactionalDb = transactionWithProgress(
        db,
        before,
        participants,
        actorId,
        state
    );

    try {
        const result = await v2.completeRaid(
            transactionalDb,
            raidKey,
            actorId,
            options
        );
        const updated = await raidRow(db, raidKey);
        return {
            ...result,
            raid: await v2.serializeRaidV2(db, updated),
            monthlyProgress: state.progress,
        };
    } catch (error) {
        throw asRaidServiceError(error);
    }
}

module.exports = {
    ...v2,
    cancelRaid,
    completeRaid,
    joinRaid,
    leaveRaid,
    removeRaidParticipant,
    transactionWithProgress,
};