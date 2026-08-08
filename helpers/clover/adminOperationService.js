'use strict';

const base = require('./adminOperationServiceBase');
const { applyAtomicAdminOperation } = require('./adminOperationAtomicService');
const { getAdminOperationExecutors } = require('./adminOperationRegistry');
const {
    assertAtomicExecutors,
    operationExecutionPolicy,
    requestedExecutionPolicy,
    withExecutionPolicy,
} = require('./adminOperationPolicy');

function executorsFor(options = {}) {
    return options.executors || getAdminOperationExecutors();
}

async function materializeRaidParticipantSelectors(db, input = {}) {
    const targets = Array.isArray(input.targets) ? input.targets : [];
    if (!targets.some((selector) => selector?.kind === 'raid_participants')) return input;

    const expanded = [];
    const snapshots = [];
    for (const selector of targets) {
        if (selector?.kind !== 'raid_participants') {
            expanded.push(selector);
            continue;
        }

        const requestedKey = String(selector.raidKey || '').trim();
        const raid = await db.get(
            `SELECT id, raid_key, name, status FROM clover_raids
             WHERE raid_key = ? OR CAST(id AS TEXT) = ?
             ORDER BY id DESC LIMIT 1`,
            [requestedKey.toUpperCase(), requestedKey]
        );
        if (!raid) {
            throw new base.AdminOperationServiceError(
                'raid_target_not_found',
                'A Raid escolhida como alvo não foi encontrada.',
                404,
                { raidKey: requestedKey }
            );
        }

        const rows = await db.all(
            `SELECT DISTINCT player_id, status
             FROM clover_raid_participants
             WHERE raid_id = ?
               AND (? = 1 OR status NOT IN ('removed', 'withdrawn'))
             ORDER BY player_id ASC`,
            [raid.id, selector.includeRemoved ? 1 : 0]
        );
        const values = rows.map((row) => String(row.player_id || '').trim()).filter(Boolean);
        if (!values.length) {
            throw new base.AdminOperationServiceError(
                'empty_raid_target',
                'A Raid escolhida não possui participantes elegíveis para esta operação.',
                404,
                { raidKey: raid.raid_key, includeRemoved: Boolean(selector.includeRemoved) }
            );
        }

        expanded.push({ kind: 'players', values });
        snapshots.push({
            requestedRaidKey: requestedKey,
            raidKey: raid.raid_key,
            raidId: Number(raid.id),
            raidName: raid.name || raid.raid_key,
            raidStatus: raid.status || null,
            includeRemoved: Boolean(selector.includeRemoved),
            playerIds: values,
            participantCount: values.length,
        });
    }

    return {
        ...input,
        targets: expanded,
        metadata: {
            ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
            raidTargetSnapshots: snapshots,
        },
    };
}

async function createAdminOperation(db, input, actor, options = {}) {
    const materialized = await materializeRaidParticipantSelectors(db, input);
    const decorated = withExecutionPolicy(materialized);
    if (requestedExecutionPolicy(decorated).policy === 'atomic') {
        assertAtomicExecutors(decorated.actions, executorsFor(options));
    }
    return base.createAdminOperation(db, decorated, actor, options);
}

async function simulateAdminOperation(db, code, actor, options = {}) {
    const operation = await base.getOperationByCode(db, code);
    if (operationExecutionPolicy(operation) === 'atomic') {
        assertAtomicExecutors(operation.actions, executorsFor(options));
    }
    return base.simulateAdminOperation(db, code, actor, options);
}

async function applyAdminOperation(db, code, actor, options = {}) {
    const operation = await base.getOperationByCode(db, code, { includeUnits: true });
    if (operationExecutionPolicy(operation) === 'atomic') {
        return applyAtomicAdminOperation(db, code, actor, {
            ...options,
            executors: executorsFor(options),
        });
    }
    return base.applyAdminOperation(db, code, actor, options);
}

module.exports = {
    ...base,
    applyAdminOperation,
    createAdminOperation,
    materializeRaidParticipantSelectors,
    simulateAdminOperation,
};
