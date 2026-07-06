const fs = require('fs');
const path = require('path');

const {
    captureArchiveSnapshotForPlayer,
    syncArchiveCardAsDeleted,
    syncArchiveCardForPlayer,
} = require('./archiveManager');

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeFilePart(value) {
    return String(value || 'player').replace(/[^a-z0-9@._-]+/gi, '_').slice(0, 120);
}

function backupDatabaseBeforePlayerReset(playerId, reason = 'player-reset') {
    const cloverRoot = path.resolve(process.env.CLOVER_RPG_DIR || process.cwd());
    const dbPath = path.resolve(process.env.CLOVER_RPG_DB || path.join(cloverRoot, 'banco.sqlite'));
    if (!fs.existsSync(dbPath)) return null;

    const backupDir = path.join(cloverRoot, 'backups', 'player-reset');
    fs.mkdirSync(backupDir, { recursive: true });

    const backupPath = path.join(
        backupDir,
        `${timestamp()}-${safeFilePart(reason)}-${safeFilePart(playerId)}.sqlite`
    );
    fs.copyFileSync(dbPath, backupPath);
    return backupPath;
}

async function runOptional(db, sql, params = []) {
    try {
        return await db.run(sql, params);
    } catch (error) {
        if (String(error?.message || '').includes('no such table')) return null;
        throw error;
    }
}

async function resetPlayerState(db, playerId) {
    await db.exec('BEGIN TRANSACTION');

    try {
        await runOptional(db, 'DELETE FROM pending_profile_confirmations WHERE player_id = ?', [playerId]);
        await runOptional(db, 'DELETE FROM pending_magic_confirmations WHERE player_id = ?', [playerId]);
        await runOptional(db, 'DELETE FROM clover_pending_skill_purchases WHERE player_id = ?', [playerId]);
        await runOptional(db, 'DELETE FROM clover_pending_hexagon_upgrades WHERE player_id = ?', [playerId]);
        await runOptional(db, 'DELETE FROM clover_trait_attempts WHERE player_id = ?', [playerId]);
        await runOptional(db, 'DELETE FROM clover_appearance_reviews WHERE player_id = ?', [playerId]);
        await runOptional(db, 'DELETE FROM clover_skill_nodes WHERE player_id = ?', [playerId]);
        await runOptional(db, 'DELETE FROM clover_inventory_items WHERE player_id = ?', [playerId]);
        await runOptional(db, 'DELETE FROM clover_quick_evaluations WHERE player_id = ?', [playerId]);
        await runOptional(db, 'DELETE FROM clover_ph_ledger WHERE player_id = ?', [playerId]);
        await runOptional(db, 'DELETE FROM clover_mana_hexagon_ledger WHERE player_id = ?', [playerId]);
        await runOptional(db, 'DELETE FROM clover_mana_hexagon WHERE player_id = ?', [playerId]);
        await runOptional(db, 'DELETE FROM clover_character_stats WHERE player_id = ?', [playerId]);
        await runOptional(
            db,
            `UPDATE slot_reservations
             SET status = 'released'
             WHERE player_id = ?
               AND status IN ('pending', 'confirmed')`,
            [playerId]
        );
        await runOptional(db, 'DELETE FROM player_rolls WHERE player_id = ?', [playerId]);
        await runOptional(db, 'DELETE FROM player_skill_trees WHERE player_id = ?', [playerId]);
        await runOptional(db, 'DELETE FROM player_progress WHERE player_id = ?', [playerId]);
        await runOptional(db, 'DELETE FROM player_onboarding WHERE player_id = ?', [playerId]);
        await runOptional(db, 'DELETE FROM group_member_welcomes WHERE player_id = ?', [playerId]);
        await runOptional(db, 'DELETE FROM jogadores WHERE id = ?', [playerId]);
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

async function syncDeletedArchiveSafely(sock, db, playerId, snapshot) {
    try {
        if (snapshot) {
            await syncArchiveCardAsDeleted({ sock, db, snapshot });
            return;
        }

        await syncArchiveCardForPlayer({ sock, db, playerId });
    } catch (error) {
        console.log('[arquivo] Nao consegui marcar ficha arquivada:', error?.message || error);
    }
}

async function archiveAndResetPlayer({ sock, db, playerId, reason = 'player-reset' }) {
    const backupPath = backupDatabaseBeforePlayerReset(playerId, reason);
    const archiveSnapshot = await captureArchiveSnapshotForPlayer(db, playerId).catch(() => null);
    await resetPlayerState(db, playerId);
    await syncDeletedArchiveSafely(sock, db, playerId, archiveSnapshot);
    return { backupPath, archiveSnapshot };
}

module.exports = {
    archiveAndResetPlayer,
    backupDatabaseBeforePlayerReset,
    resetPlayerState,
    syncDeletedArchiveSafely,
};
