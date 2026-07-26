'use strict';

const { normalizeJid } = require('../groupAccess');
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

function transactionWithHook(db, hook, state = {}) {
    return new Proxy(db, {
        get(target, property, receiver) {
            if (property === 'exec') {
                return async (sql, ...args) => {
                    const command = String(sql || '')
                        .trim()
                        .replace(/;+$/, '')
                        .toUpperCase();
                    if (command === 'COMMIT' && !state.applied) {
                        state.result = await hook(target);
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

async function runRepairTransaction(db, hook) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        const result = await hook(db);
        await db.exec('COMMIT');
        return result;
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw asRaidServiceError(error);
    }
}

async function joinRaid(db, raidKey, playerId, options = {}) {
    await ensureRaidMonthlyProgressSchema(db);
    const raid = await raidRow(db, raidKey);
    const canonicalPlayerId = normalizeJid(playerId);
    const state = { applied: false, result: null };
    const transactionalDb = transactionWithHook(db, async (target) => {
        const participant = await participantRow(target, raid.id, canonicalPlayerId);
        if (!participant) {
            throw new RaidMonthlyProgressError(
                'participant_not_found',
                'O participante não foi criado antes da reserva mensal.'
            );
        }
        return reserveParticipantInTransaction(
            target,
            raid,
            participant,
            canonicalPlayerId
        );
    }, state);

    try {
        const result = await v2.joinRaid(
            transactionalDb,
            raidKey,
            canonicalPlayerId,
            options
        );
        if (!result.duplicate) {
            return { ...result, monthlyReservation: state.result };
        }

        const participant = await participantRow(db, raid.id, result.participant?.playerId || canonicalPlayerId);
        const monthlyReservation = participant
            ? await runRepairTransaction(db, (target) => reserveParticipantInTransaction(
                target,
                raid,
                participant,
                participant.player_id
            ))
            : null;
        return { ...result, monthlyReservation };
    } catch (error) {
        throw asRaidServiceError(error);
    }
}

async function leaveRaid(db, raidKey, playerId) {
    await ensureRaidMonthlyProgressSchema(db);
    const raid = await raidRow(db, raidKey);
    const current = await participantRow(db, raid.id, normalizeJid(playerId));
    const canonicalPlayerId = current?.player_id || normalizeJid(playerId);
    const state = { applied: false, result: null };
    const transactionalDb = transactionWithHook(db, (target) => (
        releaseParticipantProgressInTransaction(
            target,
            raid,
            canonicalPlayerId,
            canonicalPlayerId,
            'participant_left'
        )
    ), state);

    try {
        const result = await v2.leaveRaid(transactionalDb, raidKey, canonicalPlayerId);
        return { ...result, monthlyProgress: state.result };
    } catch (error) {
        throw asRaidServiceError(error);
    }
}

async function removeRaidParticipant(db, raidKey, actorId, targetPlayerId, reason = null) {
    await ensureRaidMonthlyProgressSchema(db);
    const raid = await raidRow(db, raidKey);
    const current = await participantRow(db, raid.id, normalizeJid(targetPlayerId));
    const canonicalTargetId = current?.player_id || normalizeJid(targetPlayerId);
    const state = { applied: false, result: null };
    const transactionalDb = transactionWithHook(db, (target) => (
        releaseParticipantProgressInTransaction(
            target,
            raid,
            canonicalTargetId,
            actorId,
            'participant_removed'
        )
    ), state);

    try {
        const result = await v2.removeRaidParticipant(
            transactionalDb,
            raidKey,
            actorId,
            canonicalTargetId,
            reason
        );
        return { ...result, monthlyProgress: state.result };
    } catch (error) {
        throw asRaidServiceError(error);
    }
}

async function cancelRaid(db, raidKey, actorId, reason) {
    await ensureRaidMonthlyProgressSchema(db);
    const raid = await raidRow(db, raidKey);
    const state = { applied: false, result: null };
    const transactionalDb = transactionWithHook(db, (target) => (
        releaseRaidProgressInTransaction(
            target,
            raid,
            actorId,
            'raid_cancelled'
        )
    ), state);

    try {
        const result = await v2.cancelRaid(
            transactionalDb,
            raidKey,
            actorId,
            reason
        );
        if (!result.duplicate) {
            return { ...result, monthlyProgress: state.result };
        }
        const monthlyProgress = await runRepairTransaction(db, (target) => (
            releaseRaidProgressInTransaction(
                target,
                raid,
                actorId,
                'raid_cancelled_repair'
            )
        ));
        return { ...result, monthlyProgress };
    } catch (error) {
        throw asRaidServiceError(error);
    }
}

async function completeRaid(db, raidKey, actorId, options = {}) {
    await ensureRaidMonthlyProgressSchema(db);
    const before = await raidRow(db, raidKey);
    const participants = await db.all(
        `SELECT * FROM clover_raid_participants
         WHERE raid_id = ?
           AND status IN ('active', 'completed')
           AND (
               finalization_status = 'eligible'
               OR (
                   status = 'completed'
                   AND (finalization_status IS NULL OR finalization_status = 'pending')
               )
           )
         ORDER BY id ASC`,
        [before.id]
    );

    const progressHook = (target) => completeRaidProgressInTransaction(
        target,
        before,
        participants,
        actorId
    );

    if (before.status === 'completed') {
        const duplicate = await v2.completeRaid(db, raidKey, actorId, options);
        const monthlyProgress = await runRepairTransaction(db, progressHook);
        const updated = await raidRow(db, raidKey);
        return {
            ...duplicate,
            raid: await v2.serializeRaidV2(db, updated),
            monthlyProgress,
        };
    }

    const state = { applied: false, result: null };
    const transactionalDb = transactionWithHook(db, progressHook, state);

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
            monthlyProgress: state.result,
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
    runRepairTransaction,
    transactionWithHook,
};
