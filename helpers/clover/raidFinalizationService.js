'use strict';

const {
    ensureCloverSquadSchema,
} = require('../../database');
const { isSameUser, normalizeJid } = require('../groupAccess');
const {
    hasAccessPermission,
} = require('./accessControlService');
const {
    addCatalogItemInTransaction,
    ensureInventoryV1,
    getItemTemplate,
    releaseInventoryReservationInTransaction,
} = require('./inventoryService');
const legacy = require('./legacyraidService');
const { addPaInTransaction } = require('./paService');
const { addPhInTransaction, ensurePhState } = require('./phService');
const { ensureRaidFinalizationSchema } = require('./raidRewardSchema');
const {
    BOX_CATALOGS,
    getBoxCatalog,
    seedSeasonalEventTemplates,
} = require('./seasonalEventCatalog');
const {
    adjustPoderMagicoInTransaction,
} = require('./characterStatAdjustmentService');
const {
    addYullsInTransaction,
    ensureYullsState,
    ensureYullsStateInTransaction,
} = require('./yullsService');
const { normalizeSquadKey } = require('./cavalierService');
const { grantSquadStarsInTransaction } = require('./squadSeasonStarService');

const { RaidServiceError } = legacy;

const RAID_REWARD_TYPES = Object.freeze([
    'yulls',
    'ph',
    'stars',
    'catalog_item',
    'pa',
    'pm',
    'box',
]);
const PARTICIPANT_FINALIZATION_STATUSES = Object.freeze([
    'pending',
    'eligible',
    'absent',
    'ineligible',
]);

function safeJsonParse(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function optionalText(value) {
    const text = String(value || '').trim();
    return text || null;
}

function safeInteger(value, options = {}) {
    const amount = Number(value);
    const allowNegative = options.allowNegative === true;
    if (!Number.isSafeInteger(amount) || amount === 0 || (!allowNegative && amount < 0)) {
        throw new RaidServiceError(
            'invalid_reward_amount',
            allowNegative
                ? 'O valor precisa ser um número inteiro diferente de zero.'
                : 'A quantidade precisa ser um número inteiro positivo.'
        );
    }
    return amount;
}

function resolveBoxCatalog(value) {
    const input = String(value || '').trim().toLowerCase();
    if (!input) return null;
    return getBoxCatalog(input)
        || Object.values(BOX_CATALOGS).find((box) => (
            String(box.templateKey || '').toLowerCase() === input
        ))
        || null;
}

async function getRaidRow(db, raidKey) {
    await ensureRaidFinalizationSchema(db);
    const key = String(raidKey || '').trim();
    const row = await db.get(
        `SELECT * FROM clover_raids
         WHERE raid_key = ? OR CAST(id AS TEXT) = ?`,
        [key.toUpperCase(), key]
    );
    if (!row) throw new RaidServiceError('raid_not_found', 'Raid não encontrada.');
    return row;
}

async function getHostAccess(db, raid, actorId) {
    const actor = normalizeJid(actorId);
    if (isSameUser(raid.owner_player_id, actor)) {
        return { ok: true, principal: true, role: 'owner', actorId: actor };
    }
    const host = await db.get(
        `SELECT * FROM clover_raid_hosts
         WHERE raid_id = ? AND player_id = ? AND status = 'active'
         ORDER BY id DESC LIMIT 1`,
        [raid.id, actor]
    );
    return host
        ? { ok: true, principal: host.role === 'owner', role: host.role, actorId: actor, host }
        : { ok: false, principal: false, role: null, actorId: actor };
}

async function requireHost(db, raid, actorId) {
    const access = await getHostAccess(db, raid, actorId);
    if (!access.ok) {
        throw new RaidServiceError('raid_host_required', 'Apenas um host ativo pode realizar essa ação.');
    }
    return access;
}

async function writeRaidEvent(db, raidId, action, actorId, options = {}) {
    const idempotencyKey = optionalText(options.idempotencyKey);
    if (idempotencyKey) {
        const existing = await db.get(
            'SELECT * FROM clover_raid_events WHERE idempotency_key = ?',
            [idempotencyKey]
        );
        if (existing) return existing;
    }
    const inserted = await db.run(
        `INSERT INTO clover_raid_events
         (raid_id, action, actor_id, subject_player_id, before_json, after_json,
          created_at, idempotency_key, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`,
        [
            raidId,
            action,
            normalizeJid(actorId),
            options.subjectPlayerId ? normalizeJid(options.subjectPlayerId) : null,
            options.before === undefined ? null : JSON.stringify(options.before),
            options.after === undefined ? null : JSON.stringify(options.after),
            idempotencyKey,
            JSON.stringify(options.metadata || {}),
        ]
    );
    return db.get('SELECT * FROM clover_raid_events WHERE id = ?', [inserted.lastID]);
}

function serializeReward(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        raidId: Number(row.raid_id),
        targetType: row.target_type,
        targetPlayerId: row.target_player_id || null,
        rewardType: row.reward_type,
        amount: Number(row.amount),
        templateKey: row.template_key || null,
        resourceKey: row.resource_key || null,
        label: row.label,
        reason: row.reason || null,
        status: row.status,
        createdBy: row.created_by,
        createdAt: row.created_at,
        metadata: safeJsonParse(row.metadata_json, {}),
    };
}

function finalizationStatusForParticipant(row, raidStatus) {
    if (row.status === 'removed') return 'removed';
    if (row.status === 'withdrawn') return 'withdrawn';
    const stored = String(row.finalization_status || 'pending').trim().toLowerCase();
    if (PARTICIPANT_FINALIZATION_STATUSES.includes(stored)) {
        if (raidStatus === 'completed' && row.status === 'completed' && stored === 'pending') {
            return 'eligible_legacy';
        }
        return stored;
    }
    return raidStatus === 'completed' && row.status === 'completed'
        ? 'eligible_legacy'
        : 'pending';
}

function participantIsEligible(row, raidStatus) {
    const status = finalizationStatusForParticipant(row, raidStatus);
    return status === 'eligible' || status === 'eligible_legacy';
}

async function beginRaidFinalization(db, raidKey, actorId) {
    await ensureRaidFinalizationSchema(db);
    const result = await legacy.beginRaidFinalization(db, raidKey, actorId);
    if (!result.duplicate) {
        const raid = await getRaidRow(db, raidKey);
        await db.run(
            `UPDATE clover_raid_participants
             SET finalization_status = 'pending', finalization_note = NULL,
                 finalized_by = NULL, finalized_at = NULL
             WHERE raid_id = ? AND status = 'active'`,
            [raid.id]
        );
        await writeRaidEvent(db, raid.id, 'finalization_eligibility_opened', actorId, {
            metadata: { reviewRequired: true },
        });
    }
    return {
        ...result,
        finalization: await getRaidFinalizationSummary(db, raidKey, actorId),
    };
}

async function setRaidParticipantFinalization(db, raidKey, actorId, targetPlayerId, input = {}) {
    const raid = await getRaidRow(db, raidKey);
    const host = await requireHost(db, raid, actorId);
    if (raid.status !== 'finalization') {
        throw new RaidServiceError(
            'raid_not_in_finalization',
            'A elegibilidade só pode ser revisada durante a finalização.'
        );
    }

    const target = normalizeJid(targetPlayerId);
    const participant = await db.get(
        `SELECT * FROM clover_raid_participants
         WHERE raid_id = ? AND player_id = ? AND status = 'active'`,
        [raid.id, target]
    );
    if (!participant) {
        throw new RaidServiceError(
            'participant_not_active',
            'Apenas participantes ativos podem ter a elegibilidade revisada.'
        );
    }

    const status = String(input.status || input.finalizationStatus || '').trim().toLowerCase();
    if (!PARTICIPANT_FINALIZATION_STATUSES.includes(status)) {
        throw new RaidServiceError(
            'invalid_finalization_status',
            'Use pending, eligible, absent ou ineligible.'
        );
    }
    const note = optionalText(input.note || input.reason || input.motivo);
    if (['absent', 'ineligible'].includes(status) && !note) {
        throw new RaidServiceError(
            'finalization_note_required',
            'Informe o motivo da ausência ou inelegibilidade.'
        );
    }

    const before = {
        status: participant.finalization_status || 'pending',
        note: participant.finalization_note || null,
    };
    await db.run(
        `UPDATE clover_raid_participants
         SET finalization_status = ?, finalization_note = ?, finalized_by = ?,
             finalized_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [status, note, host.actorId, participant.id]
    );
    await writeRaidEvent(db, raid.id, 'participant_finalization_reviewed', host.actorId, {
        subjectPlayerId: target,
        before,
        after: { status, note },
    });
    return {
        ok: true,
        participant: {
            playerId: target,
            finalizationStatus: status,
            finalizationNote: note,
        },
        finalization: await getRaidFinalizationSummary(db, raidKey, actorId),
    };
}

async function addRaidReward(db, raidKey, actorId, input = {}) {
    const raid = await getRaidRow(db, raidKey);
    const host = await requireHost(db, raid, actorId);
    if (!['in_progress', 'finalization'].includes(raid.status)) {
        throw new RaidServiceError(
            'rewards_locked',
            'Recompensas só podem ser preparadas durante ou ao finalizar a raid.'
        );
    }

    const targetType = String(input.targetType || input.target_type || 'general').toLowerCase();
    if (!['general', 'player'].includes(targetType)) {
        throw new RaidServiceError('invalid_reward_target', 'Alvo de recompensa inválido.');
    }
    const targetPlayerId = targetType === 'player'
        ? normalizeJid(input.targetPlayerId || input.target_player_id)
        : null;
    if (targetType === 'player') {
        const participant = await db.get(
            `SELECT id FROM clover_raid_participants
             WHERE raid_id = ? AND player_id = ? AND status = 'active'`,
            [raid.id, targetPlayerId]
        );
        if (!participant) {
            throw new RaidServiceError(
                'reward_target_not_participant',
                'O alvo não é participante ativo da raid.'
            );
        }
    }

    const rewardType = String(input.rewardType || input.reward_type || '').trim().toLowerCase();
    if (!RAID_REWARD_TYPES.includes(rewardType)) {
        throw new RaidServiceError('invalid_reward_type', 'Tipo de recompensa inválido.');
    }
    const amount = safeInteger(input.amount ?? input.quantidade ?? 1, {
        allowNegative: rewardType === 'pm',
    });

    let templateKey = null;
    let resourceKey = null;
    let defaultLabel = `${amount} ${rewardType}`;

    if (rewardType === 'catalog_item') {
        templateKey = String(input.templateKey || input.template_key || '').trim();
        await ensureInventoryV1(db);
        const template = templateKey ? await getItemTemplate(db, templateKey) : null;
        if (!template) {
            throw new RaidServiceError(
                'reward_template_not_found',
                'Item não existe no catálogo da Economia.'
            );
        }
        defaultLabel = `${amount}× ${template.item_name || template.itemName || templateKey}`;
    }

    if (rewardType === 'box') {
        const box = resolveBoxCatalog(
            input.boxKey || input.box_key || input.resourceKey || input.resource_key || input.templateKey || input.template_key
        );
        if (!box) {
            throw new RaidServiceError(
                'reward_box_not_found',
                'Escolha uma caixa existente no catálogo do bot.'
            );
        }
        await seedSeasonalEventTemplates(db);
        resourceKey = box.key;
        templateKey = box.templateKey;
        defaultLabel = `${amount}× ${box.name}`;
    }

    if (rewardType === 'pa') {
        resourceKey = 'pa';
        defaultLabel = `${amount} PA`;
    }
    if (rewardType === 'pm') {
        resourceKey = 'poder_magico';
        defaultLabel = `${amount > 0 ? '+' : ''}${amount} Poder Mágico`;
    }
    if (rewardType === 'ph') defaultLabel = `${amount} PH fora do teto semanal`;
    if (rewardType === 'yulls') defaultLabel = `${amount} Yulls`;
    if (rewardType === 'stars') defaultLabel = `${amount} estrela${amount === 1 ? '' : 's'}`;

    const label = String(input.label || input.nome || defaultLabel).trim().slice(0, 160);
    const inserted = await db.run(
        `INSERT INTO clover_raid_rewards
         (raid_id, target_type, target_player_id, reward_type, amount, template_key,
          resource_key, label, reason, status, created_by, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, CURRENT_TIMESTAMP, ?)`,
        [
            raid.id,
            targetType,
            targetPlayerId,
            rewardType,
            amount,
            templateKey,
            resourceKey,
            label,
            optionalText(input.reason || input.motivo),
            host.actorId,
            JSON.stringify({
                ...(input.metadata || {}),
                unrestrictedByGameRule: true,
            }),
        ]
    );
    const reward = await db.get('SELECT * FROM clover_raid_rewards WHERE id = ?', [inserted.lastID]);
    await writeRaidEvent(db, raid.id, 'reward_drafted', host.actorId, {
        subjectPlayerId: targetPlayerId,
        after: serializeReward(reward),
    });
    return { ok: true, reward: serializeReward(reward) };
}

async function applyStarReward(db, player, reward, actorId, frozenSquadKey = null) {
    const amount = Number(reward.amount || 0);
    await db.run(
        'UPDATE jogadores SET estrelas = COALESCE(estrelas, 0) + ? WHERE id = ?',
        [amount, player.id]
    );
    const frozenKey = normalizeSquadKey(frozenSquadKey);
    const currentSquadName = String(player.esquadrao || '').trim();
    const squadKey = frozenKey || normalizeSquadKey(currentSquadName);
    if (squadKey) {
        const squadRow = await db.get(
            'SELECT name FROM clover_squads WHERE squad_key = ?',
            [squadKey]
        );
        const squadName = squadRow?.name || currentSquadName || squadKey;
        if (squadKey) {
            await db.run(
                `INSERT INTO clover_squads
                 (squad_key, name, updated_at)
                 VALUES (?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(squad_key) DO UPDATE SET
                    name = COALESCE(NULLIF(clover_squads.name, ''), excluded.name),
                    updated_at = CURRENT_TIMESTAMP`,
                [squadKey, squadName]
            );
            await grantSquadStarsInTransaction(db, {
                squadKey,
                playerId: player.id,
                amount,
                source: 'raid',
                reason: reward.reason || `Recompensa da raid ${reward.raid_id}`,
                relatedId: `raid_reward:${reward.id}:${player.id}`,
                transactionKey: `raid_reward_stars:${reward.id}:${player.id}`,
                createdBy: actorId,
                metadata: {
                    raid_id: reward.raid_id,
                    raid_reward_id: reward.id,
                    frozen_squad_key: frozenKey || null,
                },
            });
        }
    }
    return { type: 'stars', amount };
}

async function deliverRaidReward(db, raid, reward, player, actorId, options = {}) {
    const relatedId = `raid_reward:${reward.id}:${player.id}`;
    const commonMetadata = {
        raid_id: raid.id,
        raid_key: raid.raid_key,
        reward_id: reward.id,
    };

    if (reward.reward_type === 'yulls') {
        const result = await addYullsInTransaction(
            db,
            player.id,
            Number(reward.amount),
            'raid',
            reward.reason || `Recompensa: ${raid.name}`,
            actorId,
            {
                relatedId,
                idempotencyKey: `yulls:${relatedId}`,
                metadata: commonMetadata,
            }
        );
        return { type: 'yulls', amount: Number(reward.amount), ledgerId: result.ledgerId };
    }

    if (reward.reward_type === 'ph') {
        const result = await addPhInTransaction(
            db,
            player.id,
            Number(reward.amount),
            'raid',
            `${reward.reason || `Recompensa: ${raid.name}`} — fora do teto semanal`,
            actorId,
            { outside_weekly_cap: true, ...commonMetadata },
            relatedId
        );
        return {
            type: 'ph',
            amount: Number(reward.amount),
            outsideWeeklyCap: true,
            ledgerId: result.ledgerId,
        };
    }

    if (reward.reward_type === 'stars') {
        return applyStarReward(db, player, reward, actorId, options.starSquadKey || null);
    }

    if (reward.reward_type === 'pa') {
        const result = await addPaInTransaction(
            db,
            player.id,
            Number(reward.amount),
            'raid',
            reward.reason || `Recompensa: ${raid.name}`,
            actorId,
            {
                relatedId,
                idempotencyKey: `pa:${relatedId}`,
                metadata: commonMetadata,
            }
        );
        return { type: 'pa', amount: Number(reward.amount), ledgerId: result.ledgerId };
    }

    if (reward.reward_type === 'pm') {
        const result = await adjustPoderMagicoInTransaction(
            db,
            player.id,
            Number(reward.amount),
            {
                source: 'raid',
                reason: reward.reason || `Consequência: ${raid.name}`,
                relatedId,
                idempotencyKey: `pm:${relatedId}`,
                createdBy: actorId,
                metadata: commonMetadata,
            }
        );
        return {
            type: 'pm',
            amount: Number(reward.amount),
            valueBefore: result.valueBefore,
            valueAfter: result.valueAfter,
            ledgerId: result.ledgerId,
        };
    }

    const added = await addCatalogItemInTransaction(
        db,
        player.id,
        reward.template_key,
        Number(reward.amount),
        {
            source: 'raid',
            relatedId,
            createdBy: actorId,
            metadata: {
                ...commonMetadata,
                reward_type: reward.reward_type,
                box_key: reward.reward_type === 'box' ? reward.resource_key : null,
            },
        }
    );
    return {
        type: reward.reward_type,
        templateKey: reward.template_key,
        boxKey: reward.reward_type === 'box' ? reward.resource_key : null,
        quantity: Number(reward.amount),
        itemIds: added.items.map((item) => item.id),
    };
}

function rewardTargetsParticipant(reward, participant) {
    return reward.target_type === 'general'
        || isSameUser(reward.target_player_id, participant.player_id);
}

function summarizeTotals(participants) {
    const totals = {};
    for (const participant of participants) {
        for (const planned of participant.rewards || []) {
            const key = planned.rewardType;
            totals[key] = Number(totals[key] || 0) + Number(planned.amount || 0);
        }
    }
    return totals;
}

async function getRaidFinalizationSummary(db, raidKey, actorId) {
    const raid = await getRaidRow(db, raidKey);
    const actor = normalizeJid(actorId);
    const host = await getHostAccess(db, raid, actor);
    const canReviewRewardProposal = await hasAccessPermission(db, actor, 'raid.reward.review');
    const canReadAll = host.ok
        || await hasAccessPermission(db, actor, 'raid.read.all')
        || canReviewRewardProposal;
    const actorParticipant = await db.get(
        `SELECT id FROM clover_raid_participants
         WHERE raid_id = ? AND player_id = ?`,
        [raid.id, actor]
    );
    if (!canReadAll && !actorParticipant) {
        throw new RaidServiceError('raid_forbidden', 'Você não participa dessa raid.');
    }

    const participantRows = await db.all(
        `SELECT p.*, j.personagem_nome, j.nome, j.display_name, j.esquadrao, j.jogo_status
         FROM clover_raid_participants p
         JOIN jogadores j ON j.id = p.player_id
         WHERE p.raid_id = ?
         ORDER BY p.joined_at ASC, p.id ASC`,
        [raid.id]
    );
    const rewardRows = await db.all(
        `SELECT * FROM clover_raid_rewards
         WHERE raid_id = ? AND status != 'cancelled'
         ORDER BY id ASC`,
        [raid.id]
    );
    const deliveryRows = await db.all(
        `SELECT * FROM clover_raid_reward_deliveries
         WHERE raid_id = ?
         ORDER BY id ASC`,
        [raid.id]
    );
    const rewards = rewardRows.map(serializeReward);
    const deliveriesByTarget = new Map();
    for (const delivery of deliveryRows) {
        const key = `${delivery.reward_id}:${delivery.player_id}`;
        deliveriesByTarget.set(key, {
            id: Number(delivery.id),
            status: delivery.status,
            result: safeJsonParse(delivery.result_json, null),
            createdAt: delivery.created_at,
        });
    }

    const allParticipants = participantRows.map((row) => {
        const finalizationStatus = finalizationStatusForParticipant(row, raid.status);
        const eligible = participantIsEligible(row, raid.status);
        const participantRewards = rewards
            .filter((reward) => rewardTargetsParticipant({
                target_type: reward.targetType,
                target_player_id: reward.targetPlayerId,
            }, row))
            .filter(() => eligible)
            .map((reward) => ({
                ...reward,
                delivery: deliveriesByTarget.get(`${reward.id}:${row.player_id}`) || null,
            }));
        return {
            participantId: Number(row.id),
            playerId: row.player_id,
            characterName: row.personagem_nome || row.nome || row.display_name || 'Personagem',
            squad: row.esquadrao || null,
            participantStatus: row.status,
            finalizationStatus,
            finalizationNote: row.finalization_note || null,
            finalizedBy: row.finalized_by || null,
            finalizedAt: row.finalized_at || null,
            eligible,
            rewards: participantRewards,
        };
    });

    const pending = allParticipants.filter((participant) => (
        participant.participantStatus === 'active'
        && participant.finalizationStatus === 'pending'
    ));
    const eligible = allParticipants.filter((participant) => participant.eligible);
    const invalidRewardTargets = rewards
        .filter((reward) => reward.status === 'draft' && reward.targetType === 'player')
        .filter((reward) => !eligible.some((participant) => (
            isSameUser(participant.playerId, reward.targetPlayerId)
        )))
        .map((reward) => reward.id);

    const warnings = [];
    if (pending.length) {
        warnings.push({
            code: 'participant_review_pending',
            message: `${pending.length} participante(s) ainda precisam de revisão de presença.`,
            playerIds: pending.map((participant) => participant.playerId),
        });
    }
    if (invalidRewardTargets.length) {
        warnings.push({
            code: 'reward_target_not_eligible',
            message: 'Há recompensas individuais destinadas a participantes não elegíveis.',
            rewardIds: invalidRewardTargets,
        });
    }

    const visibleParticipants = canReadAll
        ? allParticipants
        : allParticipants.filter((participant) => isSameUser(participant.playerId, actor));
    const visibleRewards = canReadAll
        ? rewards
        : visibleParticipants.flatMap((participant) => participant.rewards);

    return {
        ok: true,
        raid: {
            id: Number(raid.id),
            key: raid.raid_key,
            name: raid.name,
            status: raid.status,
        },
        access: {
            isHost: host.ok,
            isPrincipalOwner: host.principal,
            canReadAll,
            canReviewRewardProposal,
        },
        participants: visibleParticipants,
        rewards: visibleRewards,
        counts: {
            totalParticipants: allParticipants.length,
            eligible: eligible.length,
            pending: pending.length,
            absent: allParticipants.filter((participant) => participant.finalizationStatus === 'absent').length,
            ineligible: allParticipants.filter((participant) => participant.finalizationStatus === 'ineligible').length,
            removed: allParticipants.filter((participant) => participant.finalizationStatus === 'removed').length,
            withdrawn: allParticipants.filter((participant) => participant.finalizationStatus === 'withdrawn').length,
            plannedDeliveries: eligible.reduce((total, participant) => total + participant.rewards.length, 0),
            completedDeliveries: deliveryRows.filter((delivery) => delivery.status === 'completed').length,
        },
        totals: summarizeTotals(visibleParticipants),
        warnings: canReadAll ? warnings : [],
        canComplete: Boolean(
            host.ok
            && raid.status === 'finalization'
            && pending.length === 0
            && invalidRewardTargets.length === 0
        ),
    };
}

async function completeRaidWithAccess(db, raid, access, raidKey, actorId, options = {}) {
    const host = access;
    const manageTransaction = options.manageTransaction !== false;
    if (raid.status === 'completed') {
        return {
            ok: true,
            duplicate: true,
            raid: legacy.serializeRaid(raid),
            finalization: await getRaidFinalizationSummary(db, raidKey, actorId),
        };
    }
    if (raid.status !== 'finalization') {
        throw new RaidServiceError(
            'raid_not_in_finalization',
            'Revise as recompensas e inicie a finalização antes de concluir.'
        );
    }

    const participants = await db.all(
        `SELECT p.*, j.esquadrao, j.personagem_nome, j.nome
         FROM clover_raid_participants p
         JOIN jogadores j ON j.id = p.player_id
         WHERE p.raid_id = ? AND p.status = 'active'
         ORDER BY p.id ASC`,
        [raid.id]
    );
    const pending = participants.filter((participant) => (
        finalizationStatusForParticipant(participant, raid.status) === 'pending'
    ));
    if (pending.length) {
        throw new RaidServiceError(
            'raid_eligibility_pending',
            'Revise a presença de todos os participantes antes de concluir.',
            { playerIds: pending.map((participant) => participant.player_id) }
        );
    }

    const eligibleParticipants = participants.filter((participant) => (
        participantIsEligible(participant, raid.status)
    ));
    const rewards = await db.all(
        `SELECT * FROM clover_raid_rewards
         WHERE raid_id = ? AND status = 'draft'
         ORDER BY id ASC`,
        [raid.id]
    );
    for (const reward of rewards) {
        const targets = reward.target_type === 'general'
            ? eligibleParticipants
            : eligibleParticipants.filter((participant) => (
                isSameUser(participant.player_id, reward.target_player_id)
            ));
        if (!targets.length) {
            throw new RaidServiceError(
                'reward_without_eligible_target',
                `A recompensa ${reward.id} não possui alvo elegível. Cancele-a ou revise a presença.`,
                { rewardId: Number(reward.id) }
            );
        }
    }

    await ensureInventoryV1(db);
    await seedSeasonalEventTemplates(db);
    await ensureCloverSquadSchema(db);
    for (const participant of eligibleParticipants) {
        if (manageTransaction) {
            await ensureYullsState(db, participant.player_id);
        } else {
            await ensureYullsStateInTransaction(db, participant.player_id);
        }
        await ensurePhState(db, participant.player_id);
    }

    if (manageTransaction) await db.exec('BEGIN IMMEDIATE');
    try {
        let deliveries = 0;
        for (const reward of rewards) {
            const targets = reward.target_type === 'general'
                ? eligibleParticipants
                : eligibleParticipants.filter((participant) => (
                    isSameUser(participant.player_id, reward.target_player_id)
                ));
            for (const player of targets) {
                const existing = await db.get(
                    `SELECT * FROM clover_raid_reward_deliveries
                     WHERE reward_id = ? AND player_id = ?`,
                    [reward.id, player.player_id]
                );
                if (existing) continue;
                const playerRow = { ...player, id: player.player_id };
                const result = await deliverRaidReward(db, raid, reward, playerRow, host.actorId, {
                    starSquadKey: options.starBeneficiarySquads?.[player.player_id] || null,
                });
                await db.run(
                    `INSERT INTO clover_raid_reward_deliveries
                     (raid_id, reward_id, player_id, status, result_json, created_at, metadata_json)
                     VALUES (?, ?, ?, 'completed', ?, CURRENT_TIMESTAMP, ?)`,
                    [
                        raid.id,
                        reward.id,
                        player.player_id,
                        JSON.stringify(result),
                        JSON.stringify({ raid_key: raid.raid_key, eligibility: 'eligible' }),
                    ]
                );
                deliveries += 1;
            }
            await db.run(
                "UPDATE clover_raid_rewards SET status = 'applied' WHERE id = ?",
                [reward.id]
            );
        }

        const reservations = await db.all(
            `SELECT id FROM clover_inventory_reservations
             WHERE source_type = 'raid' AND source_id = ? AND status = 'active'`,
            [String(raid.id)]
        );
        for (const reservation of reservations) {
            await releaseInventoryReservationInTransaction(db, reservation.id, {
                metadata: { released_by: host.actorId, reason: 'raid_completed' },
            });
        }

        await db.run(
            `UPDATE clover_raid_participants
             SET status = 'completed'
             WHERE raid_id = ? AND status = 'active'`,
            [raid.id]
        );
        await db.run(
            `UPDATE clover_raids
             SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'finalization'`,
            [raid.id]
        );
        const updated = await db.get('SELECT * FROM clover_raids WHERE id = ?', [raid.id]);
        await writeRaidEvent(db, raid.id, 'raid_completed', host.actorId, {
            after: legacy.serializeRaid(updated),
            idempotencyKey: options.idempotencyKey || null,
            metadata: {
                deliveries,
                eligibleParticipants: eligibleParticipants.length,
                excludedParticipants: participants.length - eligibleParticipants.length,
            },
        });
        if (manageTransaction) await db.exec('COMMIT');
        return {
            ok: true,
            duplicate: false,
            raid: legacy.serializeRaid(updated),
            deliveries,
            eligibleParticipants: eligibleParticipants.length,
            excludedParticipants: participants.length - eligibleParticipants.length,
            finalization: await getRaidFinalizationSummary(db, raidKey, actorId),
        };
    } catch (error) {
        if (manageTransaction) await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function completeRaid(db, raidKey, actorId, options = {}) {
    const raid = await getRaidRow(db, raidKey);
    const host = await requireHost(db, raid, actorId);
    return completeRaidWithAccess(db, raid, host, raidKey, actorId, options);
}

async function completeRaidForRewardProposal(db, raidKey, actorId, options = {}) {
    const actor = normalizeJid(actorId);
    const raid = await getRaidRow(db, raidKey);
    const proposalId = Number(options?.proposalId);
    if (!Number.isSafeInteger(proposalId) || proposalId < 1) {
        throw new RaidServiceError(
            'proposal_required',
            'A entrega por avaliador precisa de uma proposta pendente valida.'
        );
    }
    const proposal = await db.get(
        `SELECT * FROM clover_raid_reward_proposals
         WHERE id = ?`,
        [proposalId]
    );
    if (!proposal || Number(proposal.raid_id) !== Number(raid.id)) {
        throw new RaidServiceError(
            'proposal_required',
            'A proposta informada nao pertence a esta raid.'
        );
    }
    if (proposal.status !== 'pending') {
        throw new RaidServiceError(
            'proposal_not_pending',
            'Apenas propostas pendentes podem entregar recompensas.'
        );
    }
    if (isSameUser(actor, proposal.proposed_by)) {
        throw new RaidServiceError(
            'self_review_blocked',
            'Voce nao pode aprovar a propria proposta.'
        );
    }
    if (!actor || !await hasAccessPermission(db, actor, 'raid.reward.review')) {
        throw new RaidServiceError(
            'forbidden',
            'Voce nao pode revisar recompensas de raid.'
        );
    }
    return completeRaidWithAccess(
        db,
        raid,
        { ok: true, principal: false, role: 'reward_reviewer', actorId: actor },
        raidKey,
        actor,
        options
    );
}

async function getRaidDashboard(db, raidKey, actorId) {
    await ensureRaidFinalizationSchema(db);
    const dashboard = await legacy.getRaidDashboard(db, raidKey, actorId);
    return {
        ...dashboard,
        rewards: (dashboard.rewards || []).map(serializeReward),
        finalization: await getRaidFinalizationSummary(db, raidKey, actorId),
    };
}

async function getRaidParticipantDetail(db, raidKey, actorId, targetPlayerId) {
    await ensureRaidFinalizationSchema(db);
    const detail = await legacy.getRaidParticipantDetail(db, raidKey, actorId, targetPlayerId);
    const participant = await db.get(
        `SELECT finalization_status, finalization_note, finalized_by, finalized_at
         FROM clover_raid_participants
         WHERE id = ?`,
        [detail.participant.id]
    );
    const deliveries = await db.all(
        `SELECT d.*, r.reward_type, r.amount, r.label, r.resource_key, r.template_key
         FROM clover_raid_reward_deliveries d
         JOIN clover_raid_rewards r ON r.id = d.reward_id
         WHERE d.raid_id = ? AND d.player_id = ?
         ORDER BY d.id ASC`,
        [detail.raid.id, detail.participant.playerId]
    );
    return {
        ...detail,
        finalization: {
            status: finalizationStatusForParticipant(
                {
                    ...detail.participant,
                    ...participant,
                },
                detail.raid.status
            ),
            note: participant?.finalization_note || null,
            finalizedBy: participant?.finalized_by || null,
            finalizedAt: participant?.finalized_at || null,
            deliveries: deliveries.map((delivery) => ({
                id: Number(delivery.id),
                rewardId: Number(delivery.reward_id),
                rewardType: delivery.reward_type,
                amount: Number(delivery.amount),
                label: delivery.label,
                resourceKey: delivery.resource_key || null,
                templateKey: delivery.template_key || null,
                status: delivery.status,
                result: safeJsonParse(delivery.result_json, null),
                createdAt: delivery.created_at,
            })),
        },
    };
}

module.exports = {
    ...legacy,
    PARTICIPANT_FINALIZATION_STATUSES,
    RAID_REWARD_TYPES,
    addRaidReward,
    beginRaidFinalization,
    completeRaid,
    completeRaidForRewardProposal,
    deliverRaidReward,
    getRaidDashboard,
    getRaidFinalizationSummary,
    getRaidParticipantDetail,
    setRaidParticipantFinalization,
};
