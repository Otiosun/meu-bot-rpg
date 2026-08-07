'use strict';

const { isSameUser, normalizeJid } = require('../groupAccess');
const service = require('./raidTraitAwareService');

async function getRaidRow(db, raidKey) {
    await service.ensureRaidV2Schema(db);
    const key = String(raidKey || '').trim();
    const raid = await db.get(
        `SELECT * FROM clover_raids
         WHERE raid_key = ? OR CAST(id AS TEXT) = ?`,
        [key.toUpperCase(), key]
    );
    if (!raid) throw new service.RaidServiceError('raid_not_found', 'Raid não encontrada.');
    return raid;
}

async function requireActiveHost(db, raid, actorId) {
    const actor = normalizeJid(actorId) || String(actorId || '').trim();
    if (isSameUser(raid.owner_player_id, actor)) return actor;
    const hosts = await db.all(
        `SELECT player_id FROM clover_raid_hosts
         WHERE raid_id = ? AND status = 'active'`,
        [raid.id]
    );
    if ((hosts || []).some((host) => isSameUser(host.player_id, actor))) return actor;
    throw new service.RaidServiceError(
        'raid_host_required',
        'Apenas um host ativo pode realizar essa ação.'
    );
}

async function insertRaidEvent(db, raidId, action, actorId, options = {}) {
    await db.run(
        `INSERT INTO clover_raid_events
         (raid_id, action, actor_id, subject_player_id, before_json, after_json,
          created_at, idempotency_key, metadata_json)
         VALUES (?, ?, ?, NULL, NULL, ?, CURRENT_TIMESTAMP, NULL, ?)`,
        [
            Number(raidId),
            action,
            actorId,
            options.after === undefined ? null : JSON.stringify(options.after),
            JSON.stringify(options.metadata || {}),
        ]
    );
}

async function beginRaidFinalizationAtomic(db, raidKey, actorId) {
    await service.ensureRaidV2Schema(db);
    await db.exec('BEGIN IMMEDIATE');
    let updated;
    let duplicate = false;
    try {
        const raid = await getRaidRow(db, raidKey);
        const actor = await requireActiveHost(db, raid, actorId);

        if (raid.status === 'finalization') {
            duplicate = true;
            updated = raid;
            await db.exec('COMMIT');
        } else {
            if (raid.status !== 'in_progress') {
                throw new service.RaidServiceError(
                    'raid_not_in_progress',
                    'A raid não está em andamento.'
                );
            }

            await db.run(
                `UPDATE clover_raids
                 SET status = 'finalization', finalization_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = 'in_progress'`,
                [raid.id]
            );
            await db.run(
                `UPDATE clover_raid_participants
                 SET finalization_status = 'pending', finalization_note = NULL,
                     finalized_by = NULL, finalized_at = NULL
                 WHERE raid_id = ? AND status = 'active'`,
                [raid.id]
            );

            updated = await db.get('SELECT * FROM clover_raids WHERE id = ?', [raid.id]);
            const serialized = service.serializeRaid(updated);
            await insertRaidEvent(db, raid.id, 'finalization_started', actor, {
                after: serialized,
            });
            await insertRaidEvent(db, raid.id, 'finalization_eligibility_opened', actor, {
                metadata: { reviewRequired: true },
            });
            await db.exec('COMMIT');
        }
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }

    return {
        ok: true,
        duplicate,
        raid: service.serializeRaid(updated),
        finalization: await service.getRaidFinalizationSummary(db, raidKey, actorId),
    };
}

module.exports = {
    beginRaidFinalizationAtomic,
    getRaidRow,
    requireActiveHost,
};
