const fs = require('fs');
const path = require('path');

const {
    syncArchiveCardAsDeleted,
    syncArchiveCardForPlayer,
} = require('./archiveManager');
const { archivePlayer } = require('./playerLifecycleService');

class LegacyPlayerResetDisabledError extends Error {
    constructor(message = 'Reset destrutivo antigo desativado. Use PLAYER resetar pelo CloverScript.') {
        super(message);
        this.name = 'LegacyPlayerResetDisabledError';
        this.code = 'legacy_destructive_reset_disabled';
    }
}

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

async function resetPlayerState() {
    throw new LegacyPlayerResetDisabledError();
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

async function archiveAndResetPlayer({
    sock,
    db,
    playerId,
    reason = 'player-reset',
    actorId = null,
} = {}) {
    const archived = await archivePlayer(db, {
        playerId,
        reason: `rota legada convertida em arquivamento: ${reason}`,
        actorId,
    });

    if (!archived.ok) {
        return {
            ok: false,
            code: archived.code,
            error: archived.error,
            backupPath: null,
            archiveSnapshot: archived.archiveCardSnapshot || null,
            preserved: true,
        };
    }

    await syncDeletedArchiveSafely(
        sock,
        db,
        playerId,
        archived.archiveCardSnapshot
    );

    return {
        ok: true,
        backupPath: null,
        archiveSnapshot: archived.archiveCardSnapshot || null,
        lifecycleCode: archived.code,
        result: archived.result,
        before: archived.before,
        after: archived.after,
        preserved: true,
        legacyRouteConverted: true,
    };
}

module.exports = {
    LegacyPlayerResetDisabledError,
    archiveAndResetPlayer,
    backupDatabaseBeforePlayerReset,
    resetPlayerState,
    syncDeletedArchiveSafely,
};
