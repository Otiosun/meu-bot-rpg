const crypto = require('crypto');
const { normalizeText } = require('../textUtils');
const { captureArchiveSnapshotForPlayer } = require('./archiveManager');

const LIFECYCLE_STATUS = {
    ACTIVE: 'active',
    ARCHIVED: 'archived',
    REACTIVATION_PENDING: 'reactivation_pending',
};

function generateOperationCode() {
    return `LC-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function safeJsonParse(value, fallback = null) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function serialize(value) {
    return JSON.stringify(value ?? null);
}

function normalizeCompact(value) {
    return normalizeText(String(value || ''))
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isEmptyValue(value) {
    const normalized = normalizeCompact(value);
    return !normalized || ['-', 'nenhum', 'na', 'n a', 'null', 'undefined'].includes(normalized);
}

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT 1 AS found
         FROM sqlite_master
         WHERE type = 'table' AND name = ?
         LIMIT 1`,
        [tableName]
    );
    return Boolean(row?.found);
}

async function tableColumns(db, tableName) {
    const rows = await db.all(`PRAGMA table_info(${tableName})`).catch(() => []);
    return new Set((rows || []).map((row) => row.name));
}

async function addColumnIfMissing(db, tableName, columnName, definition) {
    const columns = await tableColumns(db, tableName);
    if (columns.has(columnName)) return false;
    await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    return true;
}

async function ensurePlayerLifecycleSchema(db) {
    if (!await tableExists(db, 'jogadores')) {
        throw new Error('Tabela jogadores não existe.');
    }

    await addColumnIfMissing(db, 'jogadores', 'lifecycle_status', "TEXT DEFAULT 'active'");
    await addColumnIfMissing(db, 'jogadores', 'archived_at', 'TEXT DEFAULT NULL');
    await addColumnIfMissing(db, 'jogadores', 'archived_by', 'TEXT DEFAULT NULL');
    await addColumnIfMissing(db, 'jogadores', 'archive_reason', 'TEXT DEFAULT NULL');
    await addColumnIfMissing(db, 'jogadores', 'reactivated_at', 'TEXT DEFAULT NULL');
    await addColumnIfMissing(db, 'jogadores', 'reactivated_by', 'TEXT DEFAULT NULL');

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_player_lifecycle_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation_code TEXT NOT NULL UNIQUE,
            player_id TEXT NOT NULL,
            operation_type TEXT NOT NULL
                CHECK (operation_type IN ('archive', 'reactivate')),
            source_event_id INTEGER DEFAULT NULL,
            reason TEXT NOT NULL,
            created_by TEXT DEFAULT NULL,
            before_json TEXT NOT NULL,
            after_json TEXT NOT NULL,
            result_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_lifecycle_player_created
        ON clover_player_lifecycle_events (player_id, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_lifecycle_type
        ON clover_player_lifecycle_events (operation_type, player_id, id DESC)
    `);
}

async function getPlayer(db, playerId) {
    await ensurePlayerLifecycleSchema(db);
    return db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
}

async function getActiveQueueEntries(db, playerId) {
    if (!await tableExists(db, 'clover_spell_review_queue')) return [];
    return db.all(
        `SELECT *
         FROM clover_spell_review_queue
         WHERE player_id = ?
           AND status IN ('waiting', 'called')
         ORDER BY id`,
        [playerId]
    );
}

async function getActiveReservations(db, playerId) {
    if (!await tableExists(db, 'slot_reservations')) return [];
    return db.all(
        `SELECT *
         FROM slot_reservations
         WHERE player_id = ?
           AND status IN ('pending', 'confirmed')
         ORDER BY id`,
        [playerId]
    );
}

async function getLeadershipRows(db, playerId) {
    if (!await tableExists(db, 'clover_squads')) return [];
    const columns = await tableColumns(db, 'clover_squads');
    if (!columns.has('captain_player_id') && !columns.has('vice_captain_player_id')) return [];

    const predicates = [];
    if (columns.has('captain_player_id')) predicates.push('captain_player_id = ?');
    if (columns.has('vice_captain_player_id')) predicates.push('vice_captain_player_id = ?');
    const params = predicates.map(() => playerId);

    return db.all(
        `SELECT *
         FROM clover_squads
         WHERE ${predicates.join(' OR ')}`,
        params
    );
}

async function getAntiGhostRow(db, playerId) {
    if (!await tableExists(db, 'clover_antighost_activity')) return null;
    return db.get(
        'SELECT * FROM clover_antighost_activity WHERE player_id = ?',
        [playerId]
    );
}

async function captureLifecycleSnapshot(db, playerId) {
    const player = await getPlayer(db, playerId);
    if (!player) return null;

    const [queueEntries, reservations, leadership, antiGhost] = await Promise.all([
        getActiveQueueEntries(db, playerId),
        getActiveReservations(db, playerId),
        getLeadershipRows(db, playerId),
        getAntiGhostRow(db, playerId),
    ]);

    return {
        capturedAt: new Date().toISOString(),
        player,
        queueEntries,
        reservations,
        leadership,
        antiGhost,
    };
}

function lifecycleStatusOf(player) {
    return String(player?.lifecycle_status || LIFECYCLE_STATUS.ACTIVE).trim() || LIFECYCLE_STATUS.ACTIVE;
}

function validateArchivePlayer(player) {
    if (!player) return { ok: false, code: 'player_not_found', error: 'Player não encontrado.' };
    if (Number(player.is_shadow || 0) === 1) {
        return { ok: false, code: 'shadow_player', error: 'Cadastro sombra não pode ser arquivado diretamente. Use o cadastro canônico.' };
    }
    if (lifecycleStatusOf(player) === LIFECYCLE_STATUS.ARCHIVED) {
        return { ok: false, code: 'already_archived', error: 'Player já está arquivado.' };
    }
    if (isEmptyValue(player.personagem_nome)) {
        return { ok: false, code: 'missing_character', error: 'Player não possui personagem válido para arquivar.' };
    }
    return { ok: true };
}

async function previewArchivePlayer(db, playerId) {
    const snapshot = await captureLifecycleSnapshot(db, playerId);
    const validation = validateArchivePlayer(snapshot?.player || null);
    if (!validation.ok) return { ...validation, snapshot };

    return {
        ok: true,
        player: snapshot.player,
        snapshot,
        changes: {
            lifecycleStatus: [lifecycleStatusOf(snapshot.player), LIFECYCLE_STATUS.ARCHIVED],
            gameStatus: [snapshot.player.jogo_status || '-', 'arquivado'],
            squad: [snapshot.player.esquadrao || '-', '-'],
            queueEntriesClosed: snapshot.queueEntries.length,
            reservationsReleased: snapshot.reservations.length,
            leadershipRolesCleared: snapshot.leadership.reduce((total, row) => {
                return total
                    + (row.captain_player_id === playerId ? 1 : 0)
                    + (row.vice_captain_player_id === playerId ? 1 : 0);
            }, 0),
        },
    };
}

async function clearLeadership(db, playerId) {
    if (!await tableExists(db, 'clover_squads')) return 0;
    const columns = await tableColumns(db, 'clover_squads');
    let changes = 0;

    if (columns.has('captain_player_id')) {
        const result = await db.run(
            `UPDATE clover_squads
             SET captain_player_id = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE captain_player_id = ?`,
            [playerId]
        );
        changes += Number(result?.changes || 0);
    }

    if (columns.has('vice_captain_player_id')) {
        const result = await db.run(
            `UPDATE clover_squads
             SET vice_captain_player_id = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE vice_captain_player_id = ?`,
            [playerId]
        );
        changes += Number(result?.changes || 0);
    }

    return changes;
}

async function archivePlayer(db, {
    playerId,
    reason,
    actorId = null,
    operationCode = null,
} = {}) {
    if (!reason || String(reason).trim().length < 3) {
        return { ok: false, code: 'missing_reason', error: 'Arquivamento precisa de motivo.' };
    }

    const preview = await previewArchivePlayer(db, playerId);
    if (!preview.ok) return preview;

    const archiveCardSnapshot = await captureArchiveSnapshotForPlayer(db, playerId).catch(() => null);
    const code = operationCode || generateOperationCode();

    await db.exec('BEGIN IMMEDIATE');
    try {
        const fresh = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
        const validation = validateArchivePlayer(fresh);
        if (!validation.ok) {
            await db.exec('ROLLBACK');
            return validation;
        }

        const before = await captureLifecycleSnapshot(db, playerId);

        await db.run(
            `UPDATE jogadores
             SET lifecycle_status = ?,
                 jogo_status = 'arquivado',
                 esquadrao = '-',
                 archived_at = CURRENT_TIMESTAMP,
                 archived_by = ?,
                 archive_reason = ?,
                 reactivated_at = NULL,
                 reactivated_by = NULL
             WHERE id = ?`,
            [LIFECYCLE_STATUS.ARCHIVED, actorId, String(reason).trim(), playerId]
        );

        let queueClosed = 0;
        if (await tableExists(db, 'clover_spell_review_queue')) {
            const result = await db.run(
                `UPDATE clover_spell_review_queue
                 SET status = 'removed',
                     closed_at = CURRENT_TIMESTAMP,
                     closed_by = ?,
                     reason = ?
                 WHERE player_id = ?
                   AND status IN ('waiting', 'called')`,
                [actorId, `arquivado: ${String(reason).trim()}`, playerId]
            );
            queueClosed = Number(result?.changes || 0);
        }

        let reservationsReleased = 0;
        if (await tableExists(db, 'slot_reservations')) {
            const result = await db.run(
                `UPDATE slot_reservations
                 SET status = 'released'
                 WHERE player_id = ?
                   AND status IN ('pending', 'confirmed')`,
                [playerId]
            );
            reservationsReleased = Number(result?.changes || 0);
        }

        const leadershipCleared = await clearLeadership(db, playerId);

        if (await tableExists(db, 'clover_antighost_activity')) {
            await db.run(
                `UPDATE clover_antighost_activity
                 SET candidate_at = NULL,
                     last_notice_level = NULL,
                     last_notice_at = NULL,
                     exempt_until = NULL,
                     exempt_reason = NULL,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE player_id = ?`,
                [playerId]
            ).catch(() => null);
        }

        const after = await captureLifecycleSnapshot(db, playerId);
        const result = {
            queueClosed,
            reservationsReleased,
            leadershipCleared,
            preserved: {
                player: true,
                ph: true,
                inventory: true,
                spells: true,
                history: true,
            },
        };

        await db.run(
            `INSERT INTO clover_player_lifecycle_events
             (operation_code, player_id, operation_type, reason, created_by,
              before_json, after_json, result_json)
             VALUES (?, ?, 'archive', ?, ?, ?, ?, ?)`,
            [
                code,
                playerId,
                String(reason).trim(),
                actorId,
                serialize(before),
                serialize(after),
                serialize(result),
            ]
        );

        await db.exec('COMMIT');
        return {
            ok: true,
            code,
            playerId,
            before,
            after,
            result,
            archiveCardSnapshot,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function getLatestArchiveEvent(db, playerId) {
    await ensurePlayerLifecycleSchema(db);
    return db.get(
        `SELECT *
         FROM clover_player_lifecycle_events
         WHERE player_id = ?
           AND operation_type = 'archive'
         ORDER BY id DESC
         LIMIT 1`,
        [playerId]
    );
}

async function getLatestLifecycleEvent(db, playerId) {
    await ensurePlayerLifecycleSchema(db);
    return db.get(
        `SELECT *
         FROM clover_player_lifecycle_events
         WHERE player_id = ?
         ORDER BY id DESC
         LIMIT 1`,
        [playerId]
    );
}

async function reservationConflict(db, playerId, reservation) {
    if (!await tableExists(db, 'slot_reservations')) return null;
    return db.get(
        `SELECT id, player_id, category, option_key, status
         FROM slot_reservations
         WHERE player_id <> ?
           AND category = ?
           AND option_key = ?
           AND status IN ('pending', 'confirmed')
         ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END, id
         LIMIT 1`,
        [playerId, reservation.category, reservation.option_key]
    );
}

async function squadExists(db, squadValue) {
    if (isEmptyValue(squadValue)) return false;
    if (!await tableExists(db, 'clover_squads')) return false;
    const rows = await db.all('SELECT squad_key, name FROM clover_squads');
    const expected = normalizeCompact(squadValue);
    return (rows || []).some((row) => (
        normalizeCompact(row.squad_key) === expected
        || normalizeCompact(row.name) === expected
    ));
}

async function previewReactivatePlayer(db, playerId) {
    const player = await getPlayer(db, playerId);
    if (!player) return { ok: false, code: 'player_not_found', error: 'Player não encontrado.' };
    if (lifecycleStatusOf(player) !== LIFECYCLE_STATUS.ARCHIVED) {
        return { ok: false, code: 'not_archived', error: 'Player não está arquivado.' };
    }

    const archiveEvent = await getLatestArchiveEvent(db, playerId);
    if (!archiveEvent) {
        return { ok: false, code: 'archive_snapshot_missing', error: 'Snapshot de arquivamento não encontrado.' };
    }

    const beforeArchive = safeJsonParse(archiveEvent.before_json, null);
    if (!beforeArchive?.player) {
        return { ok: false, code: 'archive_snapshot_invalid', error: 'Snapshot de arquivamento inválido.' };
    }

    const conflicts = [];
    for (const reservation of beforeArchive.reservations || []) {
        const conflict = await reservationConflict(db, playerId, reservation);
        if (conflict) conflicts.push({ reservation, conflict });
    }

    const previousSquad = beforeArchive.player.esquadrao || '-';
    const canRestoreSquad = isEmptyValue(previousSquad)
        ? true
        : await squadExists(db, previousSquad);

    return {
        ok: true,
        player,
        archiveEvent,
        beforeArchive,
        conflicts,
        changes: {
            lifecycleStatus: [lifecycleStatusOf(player), conflicts.length ? LIFECYCLE_STATUS.REACTIVATION_PENDING : LIFECYCLE_STATUS.ACTIVE],
            gameStatus: [player.jogo_status || '-', conflicts.length ? 'bloqueado' : (beforeArchive.player.jogo_status || 'bloqueado')],
            squad: [player.esquadrao || '-', canRestoreSquad ? previousSquad : '-'],
            reservationsRestored: Math.max(0, (beforeArchive.reservations || []).length - conflicts.length),
            reservationConflicts: conflicts.length,
            queueRestoredToEnd: (beforeArchive.queueEntries || []).length > 0,
            squadRestored: canRestoreSquad,
        },
    };
}

async function restoreLeadership(db, playerId, leadershipRows) {
    if (!await tableExists(db, 'clover_squads')) return { restored: 0, conflicts: [] };
    const columns = await tableColumns(db, 'clover_squads');
    const conflicts = [];
    let restored = 0;

    for (const row of leadershipRows || []) {
        const current = await db.get(
            'SELECT * FROM clover_squads WHERE squad_key = ?',
            [row.squad_key]
        );
        if (!current) {
            conflicts.push({ type: 'squad_missing', squadKey: row.squad_key });
            continue;
        }

        if (columns.has('captain_player_id') && row.captain_player_id === playerId) {
            if (!current.captain_player_id || current.captain_player_id === playerId) {
                await db.run(
                    `UPDATE clover_squads
                     SET captain_player_id = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE squad_key = ?`,
                    [playerId, row.squad_key]
                );
                restored += 1;
            } else {
                conflicts.push({ type: 'captain_occupied', squadKey: row.squad_key, currentPlayerId: current.captain_player_id });
            }
        }

        if (columns.has('vice_captain_player_id') && row.vice_captain_player_id === playerId) {
            const fresh = await db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [row.squad_key]);
            if (!fresh.vice_captain_player_id || fresh.vice_captain_player_id === playerId) {
                await db.run(
                    `UPDATE clover_squads
                     SET vice_captain_player_id = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE squad_key = ?`,
                    [playerId, row.squad_key]
                );
                restored += 1;
            } else {
                conflicts.push({ type: 'vice_occupied', squadKey: row.squad_key, currentPlayerId: fresh.vice_captain_player_id });
            }
        }
    }

    return { restored, conflicts };
}

async function restoreQueueAtEnd(db, playerId, queueEntries, actorId) {
    if (!(queueEntries || []).length) return { restored: false, reason: 'no_previous_entry' };
    if (!await tableExists(db, 'clover_spell_review_queue')) return { restored: false, reason: 'missing_table' };

    const active = await db.get(
        `SELECT id
         FROM clover_spell_review_queue
         WHERE player_id = ?
           AND status IN ('waiting', 'called')
         LIMIT 1`,
        [playerId]
    );
    if (active) return { restored: false, reason: 'already_active', entryId: active.id };

    const result = await db.run(
        `INSERT INTO clover_spell_review_queue
         (player_id, status, requested_at, called_at, closed_at, closed_by, reason)
         VALUES (?, 'waiting', CURRENT_TIMESTAMP, NULL, NULL, ?, 'reativado: retorno ao fim da fila')`,
        [playerId, actorId]
    );
    return { restored: true, entryId: result?.lastID || null };
}

async function reactivatePlayer(db, {
    playerId,
    reason,
    actorId = null,
    operationCode = null,
} = {}) {
    if (!reason || String(reason).trim().length < 3) {
        return { ok: false, code: 'missing_reason', error: 'Reativação precisa de motivo.' };
    }

    const preview = await previewReactivatePlayer(db, playerId);
    if (!preview.ok) return preview;

    const code = operationCode || generateOperationCode();

    await db.exec('BEGIN IMMEDIATE');
    try {
        const freshPreview = await previewReactivatePlayer(db, playerId);
        if (!freshPreview.ok) {
            await db.exec('ROLLBACK');
            return freshPreview;
        }

        const before = await captureLifecycleSnapshot(db, playerId);
        const previous = freshPreview.beforeArchive.player;
        const reservationConflicts = [];
        let reservationsRestored = 0;

        for (const reservation of freshPreview.beforeArchive.reservations || []) {
            const conflict = await reservationConflict(db, playerId, reservation);
            if (conflict) {
                reservationConflicts.push({ reservation, conflict });
                continue;
            }

            const result = await db.run(
                `UPDATE slot_reservations
                 SET status = ?
                 WHERE id = ?
                   AND player_id = ?
                   AND status = 'released'`,
                [reservation.status, reservation.id, playerId]
            );
            reservationsRestored += Number(result?.changes || 0);
        }

        const previousSquad = previous.esquadrao || '-';
        const canRestoreSquad = isEmptyValue(previousSquad)
            ? true
            : await squadExists(db, previousSquad);
        const nextLifecycle = reservationConflicts.length
            ? LIFECYCLE_STATUS.REACTIVATION_PENDING
            : LIFECYCLE_STATUS.ACTIVE;
        const previousGameStatus = normalizeCompact(previous.jogo_status) === 'arquivado'
            ? 'bloqueado'
            : (previous.jogo_status || 'bloqueado');
        const nextGameStatus = reservationConflicts.length ? 'bloqueado' : previousGameStatus;

        await db.run(
            `UPDATE jogadores
             SET lifecycle_status = ?,
                 jogo_status = ?,
                 esquadrao = ?,
                 archived_at = NULL,
                 archived_by = NULL,
                 archive_reason = NULL,
                 reactivated_at = CURRENT_TIMESTAMP,
                 reactivated_by = ?
             WHERE id = ?`,
            [
                nextLifecycle,
                nextGameStatus,
                canRestoreSquad ? previousSquad : '-',
                actorId,
                playerId,
            ]
        );

        const leadership = await restoreLeadership(db, playerId, freshPreview.beforeArchive.leadership || []);
        const queue = await restoreQueueAtEnd(db, playerId, freshPreview.beforeArchive.queueEntries || [], actorId);

        if (await tableExists(db, 'clover_antighost_activity')) {
            await db.run(
                `UPDATE clover_antighost_activity
                 SET last_activity_at = CURRENT_TIMESTAMP,
                     last_activity_kind = 'reactivation',
                     candidate_at = NULL,
                     last_notice_level = NULL,
                     last_notice_at = NULL,
                     exempt_until = NULL,
                     exempt_reason = NULL,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE player_id = ?`,
                [playerId]
            ).catch(() => null);
        }

        const after = await captureLifecycleSnapshot(db, playerId);
        const result = {
            reservationsRestored,
            reservationConflicts,
            squadRestored: canRestoreSquad,
            leadership,
            queue,
            gameStatusRestored: nextGameStatus,
            lifecycleStatus: nextLifecycle,
        };

        await db.run(
            `INSERT INTO clover_player_lifecycle_events
             (operation_code, player_id, operation_type, source_event_id, reason,
              created_by, before_json, after_json, result_json)
             VALUES (?, ?, 'reactivate', ?, ?, ?, ?, ?, ?)`,
            [
                code,
                playerId,
                freshPreview.archiveEvent.id,
                String(reason).trim(),
                actorId,
                serialize(before),
                serialize(after),
                serialize(result),
            ]
        );

        await db.exec('COMMIT');
        return {
            ok: true,
            code,
            playerId,
            before,
            after,
            result,
            archiveEvent: freshPreview.archiveEvent,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function getPlayerLifecycleState(db, playerId) {
    const player = await getPlayer(db, playerId);
    if (!player) return { ok: false, code: 'player_not_found', error: 'Player não encontrado.' };

    const [latestEvent, queueEntries, reservations, leadership] = await Promise.all([
        getLatestLifecycleEvent(db, playerId),
        getActiveQueueEntries(db, playerId),
        getActiveReservations(db, playerId),
        getLeadershipRows(db, playerId),
    ]);

    return {
        ok: true,
        player,
        lifecycleStatus: lifecycleStatusOf(player),
        latestEvent: latestEvent ? {
            ...latestEvent,
            before: safeJsonParse(latestEvent.before_json, null),
            after: safeJsonParse(latestEvent.after_json, null),
            result: safeJsonParse(latestEvent.result_json, null),
        } : null,
        queueEntries,
        reservations,
        leadership,
    };
}

module.exports = {
    LIFECYCLE_STATUS,
    archivePlayer,
    captureLifecycleSnapshot,
    ensurePlayerLifecycleSchema,
    generateOperationCode,
    getLatestArchiveEvent,
    getLatestLifecycleEvent,
    getPlayerLifecycleState,
    lifecycleStatusOf,
    previewArchivePlayer,
    previewReactivatePlayer,
    reactivatePlayer,
};
