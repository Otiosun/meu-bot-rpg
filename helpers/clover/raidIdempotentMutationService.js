'use strict';

const base = require('./raidFinalizationService');
const {
    findRaidMutationReceipt,
    inspectRaidMutationReceipt,
    mutationIdempotencyKey,
    writeRaidMutationReceipt,
} = require('./raidMutationIdempotency');

const { RaidServiceError } = base;

function raidMutationConflict(details = {}) {
    return new RaidServiceError(
        'idempotency_conflict',
        'Esta chave de idempotência já foi usada por outra mutação de Raid.',
        details
    );
}

function raidIdFromResult(result) {
    const candidates = [
        result?.raid?.id,
        result?.raid?.raidId,
        result?.condition?.raid_id,
        result?.condition?.raidId,
        result?.reward?.raid_id,
        result?.reward?.raidId,
    ];
    for (const candidate of candidates) {
        const value = Number(candidate);
        if (Number.isSafeInteger(value) && value > 0) return value;
    }
    return null;
}

async function runPersistentMutation(db, options = {}) {
    const input = options.input || {};
    const idempotencyKey = mutationIdempotencyKey(input);
    if (!idempotencyKey) return options.execute();

    const operation = String(options.operation || '').trim();
    const payload = {
        raidKey: String(options.raidKey || '').trim().toUpperCase(),
        actorId: String(options.actorId || '').trim(),
        input,
    };

    await db.exec('BEGIN IMMEDIATE');
    try {
        const existing = await findRaidMutationReceipt(db, idempotencyKey);
        const inspection = inspectRaidMutationReceipt(existing, operation, payload);

        if (inspection.status === 'replay') {
            await db.exec('COMMIT');
            return {
                ...inspection.result,
                duplicate: true,
                idempotentReplay: true,
            };
        }

        if (inspection.status === 'conflict' || inspection.status === 'corrupt') {
            throw raidMutationConflict({
                operation,
                raidKey: payload.raidKey,
                receiptStatus: inspection.status,
            });
        }

        const result = await options.execute();
        const raidId = raidIdFromResult(result);
        if (!raidId) {
            throw new RaidServiceError(
                'idempotency_receipt_failed',
                'A mutação ocorreu sem produzir um identificador de Raid persistível.'
            );
        }

        await writeRaidMutationReceipt(db, {
            raidId,
            operation,
            actorId: options.actorId,
            subjectPlayerId: options.subjectPlayerId,
            idempotencyKey,
            payload,
            result,
        });
        await db.exec('COMMIT');
        return {
            ...result,
            duplicate: false,
            idempotentReplay: false,
        };
    } catch (error) {
        try {
            await db.exec('ROLLBACK');
        } catch {}
        throw error;
    }
}

async function addRaidCondition(db, raidKey, actorId, input = {}) {
    return runPersistentMutation(db, {
        operation: 'add_condition',
        raidKey,
        actorId,
        input,
        subjectPlayerId: input.targetPlayerId || input.target_player_id || null,
        execute: () => base.addRaidCondition(db, raidKey, actorId, input),
    });
}

async function addRaidReward(db, raidKey, actorId, input = {}) {
    return runPersistentMutation(db, {
        operation: 'add_reward',
        raidKey,
        actorId,
        input,
        subjectPlayerId: input.targetPlayerId || input.target_player_id || null,
        execute: () => base.addRaidReward(db, raidKey, actorId, input),
    });
}

module.exports = {
    ...base,
    addRaidCondition,
    addRaidReward,
    runPersistentMutation,
};
