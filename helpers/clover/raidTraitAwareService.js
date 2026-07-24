'use strict';

const base = require('./raidMonthlyAwareService');
const { getAdminPlayerTraitOverview } = require('./adminPlayerTraitOverviewService');
const { presentNarrative } = require('./characterPresentationNarrative');

const NARRATIVE_KEYS = Object.freeze([
    'fixedTraits',
    'extraTraits',
    'extraAnomalies',
    'hooks',
    'narrativeItems',
]);

function safeJsonParse(value, fallback = null) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function isStructuredTrait(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return [
        'name',
        'description',
        'effect',
        'restrictions',
        'image',
    ].every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function hasNarrativeDetails(narrative) {
    if (!narrative || typeof narrative !== 'object' || Array.isArray(narrative)) return false;
    if (!NARRATIVE_KEYS.every((key) => Array.isArray(narrative[key]))) return false;
    return [
        ...narrative.fixedTraits,
        ...narrative.extraTraits,
        ...narrative.extraAnomalies,
    ].every(isStructuredTrait);
}

function enrichSnapshotNarrative(snapshotInput, overviewInput) {
    const snapshot = snapshotInput && typeof snapshotInput === 'object'
        ? { ...snapshotInput }
        : {};
    const narrative = presentNarrative(overviewInput, snapshot.bonus);
    return {
        ...snapshot,
        narrative,
        traits: narrative,
    };
}

async function readTraitOverview(db, playerId) {
    return getAdminPlayerTraitOverview(db, playerId);
}

async function enrichRaidSnapshotsInTransaction(db, raidId, options = {}) {
    const onlyMissing = options.onlyMissing === true;
    const participants = await db.all(
        `SELECT id, player_id, snapshot_json
         FROM clover_raid_participants
         WHERE raid_id = ? AND status IN ('active', 'completed')
         ORDER BY id ASC`,
        [Number(raidId)]
    );
    let updated = 0;

    for (const participant of participants) {
        const snapshot = safeJsonParse(participant.snapshot_json, null);
        if (!snapshot) {
            throw new base.RaidServiceError(
                'raid_snapshot_invalid',
                'A ficha congelada de um participante está ausente ou inválida.',
                { participantId: participant.id }
            );
        }
        if (onlyMissing && hasNarrativeDetails(snapshot.narrative || snapshot.traits)) continue;

        const overview = await readTraitOverview(db, participant.player_id);
        const enriched = enrichSnapshotNarrative(snapshot, overview);
        if (!hasNarrativeDetails(enriched.narrative)) {
            throw new base.RaidServiceError(
                'raid_trait_snapshot_incomplete',
                'Os detalhes públicos dos Traços não puderam ser congelados por completo.',
                { participantId: participant.id }
            );
        }
        const result = await db.run(
            `UPDATE clover_raid_participants
             SET snapshot_json = ?
             WHERE id = ?`,
            [JSON.stringify(enriched), participant.id]
        );
        if (Number(result.changes || 0) !== 1) {
            throw new base.RaidServiceError(
                'raid_trait_snapshot_write_failed',
                'A ficha congelada do participante não pôde ser atualizada.',
                { participantId: participant.id }
            );
        }
        updated += 1;
    }

    return { participants: participants.length, updated };
}

function transactionWithTraitSnapshot(db, raidId, state = {}) {
    return new Proxy(db, {
        get(target, property, receiver) {
            if (property === 'exec') {
                return async (sql, ...args) => {
                    const command = String(sql || '')
                        .trim()
                        .replace(/;+$/, '')
                        .toUpperCase();
                    if (command === 'COMMIT' && !state.applied) {
                        state.result = await enrichRaidSnapshotsInTransaction(
                            target,
                            raidId,
                            { onlyMissing: false }
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

async function findRaidRow(db, raidKey) {
    await base.ensureRaidV2Schema(db);
    const key = String(raidKey || '').trim();
    const row = await db.get(
        `SELECT * FROM clover_raids
         WHERE raid_key = ? OR CAST(id AS TEXT) = ?`,
        [key.toUpperCase(), key]
    );
    if (!row) throw new base.RaidServiceError('raid_not_found', 'Raid não encontrada.');
    return row;
}

async function repairMissingNarrative(db, raidId) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        const result = await enrichRaidSnapshotsInTransaction(db, raidId, { onlyMissing: true });
        await db.exec('COMMIT');
        return result;
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function startRaid(db, raidKey, actorId) {
    const raid = await findRaidRow(db, raidKey);
    if (raid.status === 'in_progress') {
        const result = await base.startRaid(db, raidKey, actorId);
        const traitSnapshot = await repairMissingNarrative(db, raid.id);
        return { ...result, traitSnapshot };
    }

    const state = { applied: false, result: null };
    const transactionalDb = transactionWithTraitSnapshot(db, raid.id, state);
    const result = await base.startRaid(transactionalDb, raidKey, actorId);
    return { ...result, traitSnapshot: state.result };
}

async function getRaidParticipantDetail(db, raidKey, actorId, targetPlayerId) {
    const detail = await base.getRaidParticipantDetail(db, raidKey, actorId, targetPlayerId);
    const narrative = detail.profile?.narrative
        || detail.profile?.traits
        || detail.sections?.traits
        || null;
    return {
        ...detail,
        profile: {
            ...(detail.profile || {}),
            narrative,
            traits: narrative,
        },
        sections: {
            ...(detail.sections || {}),
            traits: narrative,
        },
    };
}

module.exports = {
    ...base,
    enrichRaidSnapshotsInTransaction,
    enrichSnapshotNarrative,
    getRaidParticipantDetail,
    hasNarrativeDetails,
    isStructuredTrait,
    repairMissingNarrative,
    startRaid,
    transactionWithTraitSnapshot,
};
