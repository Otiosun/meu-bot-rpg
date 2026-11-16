'use strict';

const { isSameUser, normalizeJid } = require('../groupAccess');
const service = require('./raidTraitAwareService');
const {
    createRaidWithPersistentIdempotency,
} = require('./raidCreationIdempotency');
const {
    runClaimedRaidMutation,
} = require('./raidClaimedMutationIdempotency');

function assertOfficialCreationCategory(input = {}) {
    const rawCategory = String(input.category || input.categoria || '').trim();
    if (/[?�]/.test(rawCategory)) {
        throw new service.RaidServiceError(
            'invalid_raid_category',
            'Escolha uma categoria oficial de Raid.',
            { categories: service.getRaidCategoryCatalog() }
        );
    }
}

function normalizeChecklistOptions(options = {}) {
    const rawMonthKey = options.monthKey ?? options.month_key ?? null;
    if (rawMonthKey === null || rawMonthKey === undefined || rawMonthKey === '') return {};
    const monthKey = String(rawMonthKey).trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
        throw new service.RaidServiceError(
            'invalid_month_key',
            'Mês inválido. Use YYYY-MM.',
            { monthKey }
        );
    }
    return { monthKey };
}

function normalizeRemovalReason(value) {
    const reason = String(value || '').trim().replace(/\s+/g, ' ');
    if (reason.length < 3) {
        throw new service.RaidServiceError(
            'removal_reason_required',
            'Informe o motivo da remoção do participante.',
            { minimumLength: 3 }
        );
    }
    return reason.slice(0, 500);
}

function enforceEligibleParticipant(summary) {
    if (!summary || summary.raid?.status === 'completed') return summary;
    const pending = Number(summary.counts?.pending || 0);
    const eligible = Number(summary.counts?.eligible || 0);

    // Enquanto a revisão estiver pendente, essa é a única trava relevante.
    // Zero elegíveis só é um diagnóstico válido depois de todos serem revisados.
    if (pending > 0 || eligible > 0) return summary;

    const warnings = Array.isArray(summary.warnings) ? [...summary.warnings] : [];
    if (!warnings.some((warning) => warning.code === 'raid_without_eligible_participants')) {
        warnings.push({
            code: 'raid_without_eligible_participants',
            message: 'Marque ao menos um participante como elegível antes de concluir.',
        });
    }
    return {
        ...summary,
        warnings,
        canComplete: false,
    };
}

function mutationKey(input = {}) {
    return String(input.idempotencyKey || input.idempotency_key || '').trim();
}

function safeJsonParse(value, fallback = null) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

async function getRaidRowForMutation(db, raidKey) {
    const key = String(raidKey || '').trim();
    const row = await db.get(
        `SELECT * FROM clover_raids
         WHERE raid_key = ? OR CAST(id AS TEXT) = ?`,
        [key.toUpperCase(), key]
    );
    if (!row) throw new service.RaidServiceError('raid_not_found', 'Raid não encontrada.');
    return row;
}

async function findCommittedRaidEvent(db, options = {}) {
    const rows = await db.all(
        `SELECT * FROM clover_raid_events
         WHERE raid_id = ? AND action = ? AND actor_id = ?
           AND created_at >= ?
         ORDER BY id DESC
         LIMIT 20`,
        [
            Number(options.raidId),
            options.action,
            String(options.actorId || ''),
            options.since,
        ]
    );
    return rows.find((row) => {
        if (options.subjectPlayerId && !isSameUser(row.subject_player_id, options.subjectPlayerId)) {
            return false;
        }
        if (options.slot) {
            const metadata = safeJsonParse(row.metadata_json, {}) || {};
            if (String(metadata.slot || '').trim().toLowerCase() !== options.slot) return false;
        }
        return typeof options.matches === 'function' ? options.matches(row) : true;
    }) || null;
}

async function recoverCoHostMutation(db, options = {}) {
    const event = await findCommittedRaidEvent(db, {
        raidId: options.raidId,
        action: 'host_added',
        actorId: options.actorId,
        subjectPlayerId: options.targetPlayerId,
        since: options.claim.created_at,
    });
    if (!event) return null;
    const host = await db.get(
        `SELECT * FROM clover_raid_hosts
         WHERE raid_id = ? AND player_id = ? AND status = 'active'
         ORDER BY id DESC LIMIT 1`,
        [options.raidId, options.targetPlayerId]
    );
    return host ? { ok: true, host } : null;
}

function canonicalLoadoutInput(actorId, slotInput, input = {}) {
    const inventoryRaw = input.inventoryItemId ?? input.inventory_item_id ?? null;
    const inventoryItemId = inventoryRaw === null || inventoryRaw === '' || Number(inventoryRaw) === 0
        ? null
        : Number(inventoryRaw);
    return {
        actorId: normalizeJid(actorId) || String(actorId || '').trim(),
        targetPlayerId: normalizeJid(input.playerId || input.player_id || actorId)
            || String(input.playerId || input.player_id || actorId || '').trim(),
        slot: String(slotInput || '').trim().toLowerCase(),
        inventoryItemId,
        quantity: inventoryItemId === null ? 0 : Number(input.quantity || input.quantidade || 1),
    };
}

async function recoverLoadoutMutation(db, options = {}) {
    const participant = await db.get(
        `SELECT * FROM clover_raid_participants
         WHERE raid_id = ? AND player_id = ? AND status IN ('joined', 'active')
         ORDER BY id DESC LIMIT 1`,
        [options.raidId, options.desired.targetPlayerId]
    );
    if (!participant) return null;

    const action = options.desired.inventoryItemId === null
        ? 'loadout_slot_cleared'
        : 'loadout_slot_set';
    const event = await findCommittedRaidEvent(db, {
        raidId: options.raidId,
        action,
        actorId: options.desired.actorId,
        subjectPlayerId: options.desired.targetPlayerId,
        since: options.claim.created_at,
        slot: options.desired.slot,
        matches: (row) => {
            if (options.desired.inventoryItemId === null) return true;
            const after = safeJsonParse(row.after_json, null);
            return after
                && Number(after.inventoryItemId) === Number(options.desired.inventoryItemId)
                && Number(after.quantity) === Number(options.desired.quantity)
                && String(after.slot || '').trim().toLowerCase() === options.desired.slot;
        },
    });
    if (!event) return null;

    const current = await db.get(
        `SELECT * FROM clover_raid_loadout_items
         WHERE raid_id = ? AND participant_id = ? AND slot_key = ?
         ORDER BY id DESC LIMIT 1`,
        [options.raidId, participant.id, options.desired.slot]
    );
    if (options.desired.inventoryItemId === null) {
        return current
            ? null
            : { ok: true, cleared: true, slot: options.desired.slot, item: null };
    }
    if (
        !current
        || Number(current.inventory_item_id) !== Number(options.desired.inventoryItemId)
        || Number(current.quantity) !== Number(options.desired.quantity)
    ) {
        return null;
    }
    return {
        ok: true,
        cleared: false,
        slot: options.desired.slot,
        item: service.serializeLoadoutItem(current),
    };
}

async function recoverParticipantStateMutation(db, options = {}) {
    const event = await findCommittedRaidEvent(db, {
        raidId: options.raidId,
        action: options.action,
        actorId: options.actorId,
        subjectPlayerId: options.targetPlayerId,
        since: options.claim.created_at,
        matches: options.eventMatches,
    });
    if (!event) return null;
    const participant = await db.get(
        `SELECT * FROM clover_raid_participants
         WHERE raid_id = ? AND player_id = ?
         ORDER BY id DESC LIMIT 1`,
        [options.raidId, options.targetPlayerId]
    );
    if (!participant || participant.status !== options.expectedStatus) return null;
    if (
        options.expectedReason !== undefined
        && String(participant.removal_reason || '') !== String(options.expectedReason || '')
    ) {
        return null;
    }
    return { ok: true };
}

async function recoverJoinRaidMutation(db, options = {}) {
    const event = await findCommittedRaidEvent(db, {
        raidId: options.raidId,
        action: 'participant_joined',
        actorId: options.actorId,
        subjectPlayerId: options.targetPlayerId,
        since: options.claim.created_at,
        matches: (row) => {
            const metadata = safeJsonParse(row.metadata_json, {}) || {};
            return String(metadata.idempotencyKey || '') === String(options.idempotencyKey || '');
        },
    });
    if (!event) return null;

    const participant = await db.get(
        `SELECT * FROM clover_raid_participants
         WHERE raid_id = ? AND player_id = ?
         ORDER BY id DESC LIMIT 1`,
        [options.raidId, options.targetPlayerId]
    );
    const raid = await db.get('SELECT * FROM clover_raids WHERE id = ?', [options.raidId]);
    if (!participant || !raid) return null;

    return {
        ok: true,
        duplicate: true,
        participant: service.serializeParticipant(participant),
        raid: service.serializeRaid(raid),
    };
}

async function recoverStartRaidMutation(db, options = {}) {
    const event = await findCommittedRaidEvent(db, {
        raidId: options.raidId,
        action: 'raid_started',
        actorId: options.actorId,
        since: options.claim.created_at,
    });
    if (!event) return null;

    const raid = await db.get('SELECT * FROM clover_raids WHERE id = ?', [options.raidId]);
    if (!raid || raid.status === 'lobby') return null;
    const participants = await db.get(
        `SELECT COUNT(*) AS total FROM clover_raid_participants
         WHERE raid_id = ? AND status IN ('joined', 'active')`,
        [options.raidId]
    );
    return {
        ok: true,
        duplicate: true,
        raid: service.serializeRaid(raid),
        participants: Number(participants?.total || 0),
    };
}

async function recoverRevokeHostMutation(db, options = {}) {
    const event = await findCommittedRaidEvent(db, {
        raidId: options.raidId,
        action: 'host_revoked',
        actorId: options.actorId,
        subjectPlayerId: options.targetPlayerId,
        since: options.claim.created_at,
    });
    if (!event) return null;
    const active = await db.get(
        `SELECT id FROM clover_raid_hosts
         WHERE raid_id = ? AND player_id = ? AND status = 'active'
         ORDER BY id DESC LIMIT 1`,
        [options.raidId, options.targetPlayerId]
    );
    return active ? null : { ok: true };
}

async function recoverResolveConditionMutation(db, options = {}) {
    const event = await findCommittedRaidEvent(db, {
        raidId: options.raidId,
        action: 'condition_resolved',
        actorId: options.actorId,
        since: options.claim.created_at,
        matches: (row) => {
            const after = safeJsonParse(row.after_json, null);
            return after && Number(after.id) === Number(options.conditionId);
        },
    });
    if (!event) return null;
    const condition = await db.get(
        `SELECT * FROM clover_raid_conditions
         WHERE id = ? AND raid_id = ?`,
        [Number(options.conditionId), options.raidId]
    );
    if (!condition || condition.status !== 'resolved') return null;
    if (String(condition.resolution_note || '') !== String(options.note || '')) return null;
    return { ok: true, condition };
}

async function recoverCancelRewardMutation(db, options = {}) {
    const event = await findCommittedRaidEvent(db, {
        raidId: options.raidId,
        action: 'reward_cancelled',
        actorId: options.actorId,
        since: options.claim.created_at,
        matches: (row) => {
            const metadata = safeJsonParse(row.metadata_json, {}) || {};
            return Number(metadata.reward_id) === Number(options.rewardId);
        },
    });
    if (!event) return null;
    const reward = await db.get(
        `SELECT * FROM clover_raid_rewards
         WHERE id = ? AND raid_id = ?`,
        [Number(options.rewardId), options.raidId]
    );
    return reward?.status === 'cancelled' ? { ok: true } : null;
}

async function recoverCancelRaidMutation(db, options = {}) {
    const event = await findCommittedRaidEvent(db, {
        raidId: options.raidId,
        action: 'raid_cancelled',
        actorId: options.actorId,
        since: options.claim.created_at,
        matches: (row) => {
            const metadata = safeJsonParse(row.metadata_json, {}) || {};
            return String(metadata.reason || '') === String(options.reason || '');
        },
    });
    if (!event) return null;
    const raid = await db.get('SELECT * FROM clover_raids WHERE id = ?', [options.raidId]);
    if (!raid || raid.status !== 'cancelled') return null;
    if (String(raid.cancellation_reason || '') !== String(options.reason || '')) return null;
    return { ok: true, raid: service.serializeRaid(raid) };
}

async function createRaid(db, actorId, input = {}) {
    assertOfficialCreationCategory(input);
    await service.ensureRaidV2Schema(db);
    return createRaidWithPersistentIdempotency(db, actorId, input, {
        errorFactory: (code, message, details = {}) => (
            new service.RaidServiceError(code, message, details)
        ),
        execute: (preparedInput) => service.createRaid(db, actorId, preparedInput),
        recover: async (raidKey) => {
            const dashboard = await service.getRaidDashboard(db, raidKey, actorId);
            return {
                ok: true,
                raid: dashboard.raid,
                role: 'owner',
                principal: true,
            };
        },
    });
}

async function joinRaid(db, raidKey, playerId, options = {}) {
    const idempotencyKey = mutationKey(options);
    if (!idempotencyKey) return service.joinRaid(db, raidKey, playerId, options);

    await service.ensureRaidV2Schema(db);
    const raid = await getRaidRowForMutation(db, raidKey);
    const actor = normalizeJid(playerId) || String(playerId || '').trim();
    const via = String(options.via || 'site');
    const payload = { raidKey: raid.raid_key, actorId: actor, via };
    return runClaimedRaidMutation(db, {
        operation: 'join_raid',
        input: { idempotencyKey },
        payload,
        actorId: actor,
        subjectPlayerId: actor,
        raidId: Number(raid.id),
        errorFactory: (code, message, details = {}) => new service.RaidServiceError(code, message, details),
        recover: ({ claim }) => recoverJoinRaidMutation(db, {
            claim,
            raidId: Number(raid.id),
            actorId: actor,
            targetPlayerId: actor,
            idempotencyKey,
        }),
        execute: () => service.joinRaid(db, raidKey, playerId, {
            ...options,
            via,
            metadata: { ...(options.metadata || {}), idempotencyKey },
        }),
    });
}

async function startRaid(db, raidKey, actorId, options = {}) {
    const idempotencyKey = mutationKey(options);
    if (!idempotencyKey) return service.startRaid(db, raidKey, actorId);

    await service.ensureRaidV2Schema(db);
    const raid = await getRaidRowForMutation(db, raidKey);
    const actor = normalizeJid(actorId) || String(actorId || '').trim();
    const payload = { raidKey: raid.raid_key, actorId: actor };
    return runClaimedRaidMutation(db, {
        operation: 'start_raid',
        input: { idempotencyKey },
        payload,
        actorId: actor,
        raidId: Number(raid.id),
        errorFactory: (code, message, details = {}) => new service.RaidServiceError(code, message, details),
        recover: ({ claim }) => recoverStartRaidMutation(db, {
            claim,
            raidId: Number(raid.id),
            actorId: actor,
        }),
        execute: () => service.startRaid(db, raidKey, actorId),
    });
}

async function addRaidHost(db, raidKey, actorId, targetPlayerId, options = {}) {
    const idempotencyKey = mutationKey(options);
    if (!idempotencyKey) return service.addRaidHost(db, raidKey, actorId, targetPlayerId);

    await service.ensureRaidV2Schema(db);
    const raid = await getRaidRowForMutation(db, raidKey);
    const actor = normalizeJid(actorId) || String(actorId || '').trim();
    const target = normalizeJid(targetPlayerId) || String(targetPlayerId || '').trim();
    const payload = {
        raidKey: raid.raid_key,
        actorId: actor,
        targetPlayerId: target,
    };
    return runClaimedRaidMutation(db, {
        operation: 'add_raid_host',
        input: { idempotencyKey },
        payload,
        actorId: actor,
        subjectPlayerId: target,
        raidId: Number(raid.id),
        errorFactory: (code, message, details = {}) => (
            new service.RaidServiceError(code, message, details)
        ),
        recover: ({ claim }) => recoverCoHostMutation(db, {
            claim,
            raidId: Number(raid.id),
            actorId: actor,
            targetPlayerId: target,
        }),
        execute: () => service.addRaidHost(db, raidKey, actorId, targetPlayerId),
    });
}

async function setRaidLoadoutSlot(db, raidKey, actorId, slotInput, input = {}) {
    const idempotencyKey = mutationKey(input);
    if (!idempotencyKey) return service.setRaidLoadoutSlot(db, raidKey, actorId, slotInput, input);

    await service.ensureRaidV2Schema(db);
    const raid = await getRaidRowForMutation(db, raidKey);
    const desired = canonicalLoadoutInput(actorId, slotInput, input);
    const payload = {
        raidKey: raid.raid_key,
        ...desired,
    };
    return runClaimedRaidMutation(db, {
        operation: 'set_raid_loadout_slot',
        input: { idempotencyKey },
        payload,
        actorId: desired.actorId,
        subjectPlayerId: desired.targetPlayerId,
        raidId: Number(raid.id),
        errorFactory: (code, message, details = {}) => (
            new service.RaidServiceError(code, message, details)
        ),
        recover: ({ claim }) => recoverLoadoutMutation(db, {
            claim,
            raidId: Number(raid.id),
            desired,
        }),
        execute: () => service.setRaidLoadoutSlot(db, raidKey, actorId, slotInput, input),
    });
}

async function leaveRaid(db, raidKey, playerId, options = {}) {
    const idempotencyKey = mutationKey(options);
    if (!idempotencyKey) return service.leaveRaid(db, raidKey, playerId);

    await service.ensureRaidV2Schema(db);
    const raid = await getRaidRowForMutation(db, raidKey);
    const actor = normalizeJid(playerId) || String(playerId || '').trim();
    const payload = { raidKey: raid.raid_key, actorId: actor };
    return runClaimedRaidMutation(db, {
        operation: 'leave_raid',
        input: { idempotencyKey },
        payload,
        actorId: actor,
        subjectPlayerId: actor,
        raidId: Number(raid.id),
        errorFactory: (code, message, details = {}) => new service.RaidServiceError(code, message, details),
        recover: ({ claim }) => recoverParticipantStateMutation(db, {
            claim,
            raidId: Number(raid.id),
            action: 'participant_left',
            actorId: actor,
            targetPlayerId: actor,
            expectedStatus: 'withdrawn',
            expectedReason: 'Saída voluntária',
        }),
        execute: () => service.leaveRaid(db, raidKey, playerId),
    });
}

async function revokeRaidHost(db, raidKey, actorId, targetPlayerId, options = {}) {
    const idempotencyKey = mutationKey(options);
    if (!idempotencyKey) return service.revokeRaidHost(db, raidKey, actorId, targetPlayerId);

    await service.ensureRaidV2Schema(db);
    const raid = await getRaidRowForMutation(db, raidKey);
    const actor = normalizeJid(actorId) || String(actorId || '').trim();
    const target = normalizeJid(targetPlayerId) || String(targetPlayerId || '').trim();
    const payload = { raidKey: raid.raid_key, actorId: actor, targetPlayerId: target };
    return runClaimedRaidMutation(db, {
        operation: 'revoke_raid_host',
        input: { idempotencyKey },
        payload,
        actorId: actor,
        subjectPlayerId: target,
        raidId: Number(raid.id),
        errorFactory: (code, message, details = {}) => new service.RaidServiceError(code, message, details),
        recover: ({ claim }) => recoverRevokeHostMutation(db, {
            claim,
            raidId: Number(raid.id),
            actorId: actor,
            targetPlayerId: target,
        }),
        execute: () => service.revokeRaidHost(db, raidKey, actorId, targetPlayerId),
    });
}

async function resolveRaidCondition(db, raidKey, actorId, conditionId, note = null, options = {}) {
    const idempotencyKey = mutationKey(options);
    if (!idempotencyKey) return service.resolveRaidCondition(db, raidKey, actorId, conditionId, note);

    await service.ensureRaidV2Schema(db);
    const raid = await getRaidRowForMutation(db, raidKey);
    const actor = normalizeJid(actorId) || String(actorId || '').trim();
    const cleanNote = String(note || '').trim() || null;
    const payload = {
        raidKey: raid.raid_key,
        actorId: actor,
        conditionId: Number(conditionId),
        note: cleanNote,
    };
    return runClaimedRaidMutation(db, {
        operation: 'resolve_raid_condition',
        input: { idempotencyKey },
        payload,
        actorId: actor,
        raidId: Number(raid.id),
        errorFactory: (code, message, details = {}) => new service.RaidServiceError(code, message, details),
        recover: ({ claim }) => recoverResolveConditionMutation(db, {
            claim,
            raidId: Number(raid.id),
            actorId: actor,
            conditionId: Number(conditionId),
            note: cleanNote,
        }),
        execute: () => service.resolveRaidCondition(db, raidKey, actorId, conditionId, note),
    });
}

async function cancelRaidReward(db, raidKey, actorId, rewardId, options = {}) {
    const idempotencyKey = mutationKey(options);
    if (!idempotencyKey) return service.cancelRaidReward(db, raidKey, actorId, rewardId);

    await service.ensureRaidV2Schema(db);
    const raid = await getRaidRowForMutation(db, raidKey);
    const actor = normalizeJid(actorId) || String(actorId || '').trim();
    const payload = {
        raidKey: raid.raid_key,
        actorId: actor,
        rewardId: Number(rewardId),
    };
    return runClaimedRaidMutation(db, {
        operation: 'cancel_raid_reward',
        input: { idempotencyKey },
        payload,
        actorId: actor,
        raidId: Number(raid.id),
        errorFactory: (code, message, details = {}) => new service.RaidServiceError(code, message, details),
        recover: ({ claim }) => recoverCancelRewardMutation(db, {
            claim,
            raidId: Number(raid.id),
            actorId: actor,
            rewardId: Number(rewardId),
        }),
        execute: () => service.cancelRaidReward(db, raidKey, actorId, rewardId),
    });
}

async function cancelRaid(db, raidKey, actorId, reason = null, options = {}) {
    const idempotencyKey = mutationKey(options);
    if (!idempotencyKey) return service.cancelRaid(db, raidKey, actorId, reason);

    await service.ensureRaidV2Schema(db);
    const raid = await getRaidRowForMutation(db, raidKey);
    const actor = normalizeJid(actorId) || String(actorId || '').trim();
    const cleanReason = String(reason || '').trim() || null;
    const payload = { raidKey: raid.raid_key, actorId: actor, reason: cleanReason };
    return runClaimedRaidMutation(db, {
        operation: 'cancel_raid',
        input: { idempotencyKey },
        payload,
        actorId: actor,
        raidId: Number(raid.id),
        errorFactory: (code, message, details = {}) => new service.RaidServiceError(code, message, details),
        recover: ({ claim }) => recoverCancelRaidMutation(db, {
            claim,
            raidId: Number(raid.id),
            actorId: actor,
            reason: cleanReason,
        }),
        execute: () => service.cancelRaid(db, raidKey, actorId, reason),
    });
}

async function getPlayerRaidChecklist(db, playerId, options = {}) {
    const checklist = await service.getPlayerRaidChecklist(
        db,
        playerId,
        normalizeChecklistOptions(options)
    );
    const { playerId: _privatePlayerId, ...publicChecklist } = checklist;
    return publicChecklist;
}

async function getRaidFinalizationSummary(db, raidKey, actorId) {
    return enforceEligibleParticipant(
        await service.getRaidFinalizationSummary(db, raidKey, actorId)
    );
}

async function getRaidDashboard(db, raidKey, actorId) {
    const dashboard = await service.getRaidDashboard(db, raidKey, actorId);
    return dashboard?.finalization
        ? { ...dashboard, finalization: enforceEligibleParticipant(dashboard.finalization) }
        : dashboard;
}

async function completeRaid(db, raidKey, actorId, options = {}) {
    const summary = await getRaidFinalizationSummary(db, raidKey, actorId);
    const pending = Number(summary.counts?.pending || 0);
    const eligible = Number(summary.counts?.eligible || 0);

    // A revisão pendente é a primeira trava. O erro de zero elegíveis só faz
    // sentido depois que o host classificou todos os participantes.
    if (summary.raid?.status !== 'completed' && pending === 0 && eligible === 0) {
        throw new service.RaidServiceError(
            'raid_without_eligible_participants',
            'Marque ao menos um participante como elegível antes de concluir a raid.'
        );
    }
    return service.completeRaid(db, raidKey, actorId, options);
}

async function completeRaidForRewardProposal(db, raidKey, actorId, options = {}) {
    const summary = await getRaidFinalizationSummary(db, raidKey, actorId);
    const pending = Number(summary.counts?.pending || 0);
    const eligible = Number(summary.counts?.eligible || 0);

    if (summary.raid?.status !== 'completed' && pending === 0 && eligible === 0) {
        throw new service.RaidServiceError(
            'raid_without_eligible_participants',
            'Marque ao menos um participante como elegivel antes de concluir a raid.'
        );
    }
    return service.completeRaidForRewardProposal(db, raidKey, actorId, options);
}

async function removeRaidParticipant(db, raidKey, actorId, targetPlayerId, reason, options = {}) {
    const cleanReason = normalizeRemovalReason(reason);
    const idempotencyKey = mutationKey(options);
    if (!idempotencyKey) {
        return service.removeRaidParticipant(db, raidKey, actorId, targetPlayerId, cleanReason);
    }

    await service.ensureRaidV2Schema(db);
    const raid = await getRaidRowForMutation(db, raidKey);
    const actor = normalizeJid(actorId) || String(actorId || '').trim();
    const target = normalizeJid(targetPlayerId) || String(targetPlayerId || '').trim();
    const payload = {
        raidKey: raid.raid_key,
        actorId: actor,
        targetPlayerId: target,
        reason: cleanReason,
    };
    return runClaimedRaidMutation(db, {
        operation: 'remove_raid_participant',
        input: { idempotencyKey },
        payload,
        actorId: actor,
        subjectPlayerId: target,
        raidId: Number(raid.id),
        errorFactory: (code, message, details = {}) => new service.RaidServiceError(code, message, details),
        recover: ({ claim }) => recoverParticipantStateMutation(db, {
            claim,
            raidId: Number(raid.id),
            action: 'participant_removed',
            actorId: actor,
            targetPlayerId: target,
            expectedStatus: 'removed',
            expectedReason: cleanReason,
            eventMatches: (row) => {
                const metadata = safeJsonParse(row.metadata_json, {}) || {};
                return String(metadata.reason || '') === cleanReason;
            },
        }),
        execute: () => service.removeRaidParticipant(db, raidKey, actorId, targetPlayerId, cleanReason),
    });
}

module.exports = {
    ...service,
    addRaidHost,
    cancelRaid,
    cancelRaidReward,
    assertOfficialCreationCategory,
    completeRaid,
    completeRaidForRewardProposal,
    createRaid,
    enforceEligibleParticipant,
    getPlayerRaidChecklist,
    getRaidDashboard,
    getRaidFinalizationSummary,
    joinRaid,
    normalizeChecklistOptions,
    normalizeRemovalReason,
    leaveRaid,
    removeRaidParticipant,
    resolveRaidCondition,
    revokeRaidHost,
    setRaidLoadoutSlot,
    startRaid,
};
