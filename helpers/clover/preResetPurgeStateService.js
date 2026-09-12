'use strict';

async function hasPurgeTable(db) {
    const row = await db.get(
        "SELECT 1 AS ok FROM sqlite_schema WHERE type = 'table' AND name = 'clover_prereset_purge_tombstones'"
    );
    return Boolean(row?.ok);
}

function parseTombstone(row) {
    if (!row) return null;
    let snapshot = null;
    try { snapshot = JSON.parse(row.snapshot_json); } catch {}
    return Object.freeze({
        playerId: row.player_id,
        operationKey: row.operation_key,
        actorId: row.actor_id,
        reason: row.reason,
        requestHash: row.request_hash,
        confirmationHash: row.confirmation_hash,
        snapshot,
        snapshotHash: row.snapshot_hash,
        createdAt: row.created_at,
    });
}

async function getPreResetPurgeTombstone(db, playerId) {
    if (!await hasPurgeTable(db)) return null;
    const row = await db.get(
        'SELECT * FROM clover_prereset_purge_tombstones WHERE player_id = ?',
        [String(playerId || '').trim()]
    );
    return parseTombstone(row);
}

async function isPreResetPlayerPurged(db, playerId) {
    return Boolean(await getPreResetPurgeTombstone(db, playerId));
}

module.exports = {
    getPreResetPurgeTombstone,
    hasPurgeTable,
    isPreResetPlayerPurged,
    parseTombstone,
};
