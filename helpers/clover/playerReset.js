const fs = require('fs');
const path = require('path');

const {
    captureArchiveSnapshotForPlayer,
    syncArchiveCardAsDeleted,
    syncArchiveCardForPlayer,
} = require('./archiveManager');
const {
    archivePlayer,
} = require('./playerLifecycleService');

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

async function resetPlayerState(db, playerId, options = {}) {
    const reason = String(options.reason || 'encerramento legado convertido em arquivamento seguro').trim();
    const actorId = options.actorId || 'system';
    const result = await archivePlayer(db, {
        playerId,
        reason,
        actorId,
    });

    if (!result?.ok && result?.code !== 'already_archived') {
        const error = new Error(result?.error || result?.code || 'Não consegui arquivar o player com segurança.');
        error.code = result?.code || 'safe_archive_failed';
        error.details = result || null;
        throw error;
    }

    return {
        ok: true,
        archived: true,
        alreadyArchived: result?.code === 'already_archived',
        lifecycle: result,
    };
}

async function syncDeletedArchiveSafely(sock, db, playerId, snapshot) {
    try {
        if (snapshot) {
            return await syncArchiveCardAsDeleted({ sock, db, snapshot });
        }

        return await syncArchiveCardForPlayer({ sock, db, playerId });
    } catch (error) {
        console.log('[arquivo] Nao consegui marcar ficha arquivada:', error?.message || error);
        return { ok: false, error: error?.message || String(error) };
    }
}

async function archiveAndResetPlayer({ sock, db, playerId, reason = 'player-reset', actorId = 'system' }) {
    const backupPath = backupDatabaseBeforePlayerReset(playerId, reason);
    const archiveSnapshot = await captureArchiveSnapshotForPlayer(db, playerId).catch(() => null);
    const safeResult = await resetPlayerState(db, playerId, {
        reason: `compatibilidade segura: ${reason}`,
        actorId,
    });
    const archiveSync = await syncDeletedArchiveSafely(sock, db, playerId, archiveSnapshot);

    return {
        ok: true,
        mode: 'lifecycle_archive',
        backupPath,
        archiveSnapshot,
        archiveSync,
        lifecycle: safeResult.lifecycle,
        alreadyArchived: safeResult.alreadyArchived,
    };
}

module.exports = {
    archiveAndResetPlayer,
    backupDatabaseBeforePlayerReset,
    resetPlayerState,
    syncDeletedArchiveSafely,
};
