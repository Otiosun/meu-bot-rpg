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

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function prunePlayerResetBackups(backupDir, options = {}) {
    if (!fs.existsSync(backupDir)) return { removed: [] };

    const keepPerKey = positiveInteger(
        options.keepPerKey ?? process.env.CLOVER_PLAYER_RESET_BACKUPS_PER_KEY,
        5
    );
    const maxAgeDays = positiveInteger(
        options.maxAgeDays ?? process.env.CLOVER_PLAYER_RESET_BACKUP_MAX_AGE_DAYS,
        30
    );
    const nowMs = options.nowMs || Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(backupDir)
        .filter((name) => name.toLowerCase().endsWith('.sqlite'))
        .map((name) => {
            const fullPath = path.join(backupDir, name);
            const stat = fs.statSync(fullPath);
            const key = name.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z?-/, '');
            return { name, fullPath, key, mtimeMs: stat.mtimeMs };
        });

    const remove = new Set(
        files.filter((file) => nowMs - file.mtimeMs > maxAgeMs).map((file) => file.fullPath)
    );

    const groups = new Map();
    for (const file of files) {
        if (!groups.has(file.key)) groups.set(file.key, []);
        groups.get(file.key).push(file);
    }

    for (const group of groups.values()) {
        group.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
        for (const file of group.slice(keepPerKey)) remove.add(file.fullPath);
    }

    const removed = [];
    for (const fullPath of remove) {
        try {
            fs.rmSync(fullPath, { force: true });
            removed.push(fullPath);
        } catch (error) {
            console.log('[player-reset] Nao consegui remover backup antigo:', fullPath, error?.message || error);
        }
    }

    return { removed, keepPerKey, maxAgeDays };
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
    prunePlayerResetBackups(backupDir);
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
    prunePlayerResetBackups,
    resetPlayerState,
    syncDeletedArchiveSafely,
};
