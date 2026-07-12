const crypto = require('crypto');

const { normalizeText } = require('../textUtils');
const {
    captureLifecycleSnapshot,
    ensurePlayerLifecycleSchema,
} = require('./playerLifecycleService');

function generateUndoCode() {
    return `LU-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
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

async function ensurePlayerLifecycleUndoSchema(db) {
    await ensurePlayerLifecycleSchema(db);
    await addColumnIfMissing(db, 'clover_player_lifecycle_events', 'undone_at', 'TEXT DEFAULT NULL');
    await addColumnIfMissing(db, 'clover_player_lifecycle_events', 'undone_by', 'TEXT DEFAULT NULL');
    await addColumnIfMissing(db, 'clover_player_lifecycle_events', 'undo_reason', 'TEXT DEFAULT NULL');
    await addColumnIfMissing(db, 'clover_player_lifecycle_events', 'undo_operation_code', 'TEXT DEFAULT NULL');

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_player_lifecycle_undos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation_code TEXT NOT NULL UNIQUE,
            source_event_id INTEGER NOT NULL UNIQUE,
            source_operation_code TEXT NOT NULL,
            player_id TEXT NOT NULL,
            reason TEXT NOT NULL,
            created_by TEXT DEFAULT NULL,
            before_undo_json TEXT NOT NULL,
            restored_json TEXT NOT NULL,
            result_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_clover_lifecycle_undos_player
        ON clover_player_lifecycle_undos (player_id, created_at DESC, id DESC);
    `);
}

async function resolveLifecycleEventCode(db, rawCode) {
    await ensurePlayerLifecycleUndoSchema(db);
    const code = String(rawCode || '').trim().toUpperCase();
    if (!code) return { ok: false, code: 'missing_source_code', error: 'Informe o código que será desfeito.' };

    if (code.startsWith('LU-') || code.startsWith('CSU-')) {
        return { ok: false, code: 'undo_of_undo_not_supported', error: 'Não é permitido desfazer um desfazer nesta versão.' };
    }

    if (code.startsWith('LC-')) {
        const event = await db.get(
            'SELECT * FROM clover_player_lifecycle_events WHERE operation_code = ?',
            [code]
        );
        return event
            ? { ok: true, event, sourceCode: code }
            : { ok: false, code: 'lifecycle_event_not_found', error: `Evento ${code} não encontrado.` };
    }

    let simulationCode = code;
    if (code.startsWith('JOB-') && await tableExists(db, 'clover_script_jobs')) {
        const job = await db.get(
            'SELECT simulation_code FROM clover_script_jobs WHERE code = ?',
            [code]
        );
        if (!job?.simulation_code) {
            return { ok: false, code: 'job_not_found', error: `Tarefa ${code} não encontrada.` };
        }
        simulationCode = String(job.simulation_code).toUpperCase();
    }

    if (simulationCode.startsWith('CS-') || simulationCode.startsWith('CSL-')) {
        if (!await tableExists(db, 'clover_script_runs') || !await tableExists(db, 'clover_script_actions')) {
            return { ok: false, code: 'script_history_missing', error: 'Histórico do CloverScript não está disponível.' };
        }
        const run = await db.get(
            'SELECT * FROM clover_script_runs WHERE code = ?',
            [simulationCode]
        );
        if (!run) return { ok: false, code: 'script_run_not_found', error: `Simulação ${simulationCode} não encontrada.` };
        if (run.status !== 'applied') {
            return { ok: false, code: 'script_not_applied', error: `O código ${simulationCode} não está aplicado.` };
        }

        const actions = await db.all(
            `SELECT *
             FROM clover_script_actions
             WHERE run_id = ? AND status = 'applied'
             ORDER BY id DESC`,
            [run.id]
        );
        for (const action of actions || []) {
            const after = safeJsonParse(action.after_json, null);
            const lifecycleCode = after?.lifecycleCode || after?.lifecycle_code || null;
            if (!lifecycleCode) continue;
            const event = await db.get(
                'SELECT * FROM clover_player_lifecycle_events WHERE operation_code = ?',
                [String(lifecycleCode).toUpperCase()]
            );
            if (event) return { ok: true, event, sourceCode: code, simulationCode };
        }
        return {
            ok: false,
            code: 'unsupported_undo_source',
            error: 'Este código não contém uma operação de arquivamento/reativação compatível com desfazer.',
        };
    }

    return { ok: false, code: 'unsupported_source_code', error: `Código ${code} não é compatível com desfazer.` };
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value ?? null;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function operationalSignature(snapshot) {
    const player = snapshot?.player || {};
    return stable({
        player: {
            id: player.id || null,
            lifecycle_status: player.lifecycle_status || 'active',
            jogo_status: player.jogo_status || null,
            esquadrao: player.esquadrao || null,
            archived_at: player.archived_at || null,
            archived_by: player.archived_by || null,
            archive_reason: player.archive_reason || null,
            reactivated_at: player.reactivated_at || null,
            reactivated_by: player.reactivated_by || null,
        },
        queueEntries: (snapshot?.queueEntries || []).map((row) => ({
            id: Number(row.id),
            status: row.status,
            requested_at: row.requested_at || null,
            called_at: row.called_at || null,
        })).sort((a, b) => a.id - b.id),
        reservations: (snapshot?.reservations || []).map((row) => ({
            id: Number(row.id),
            category: row.category,
            option_key: row.option_key,
            status: row.status,
        })).sort((a, b) => a.id - b.id),
        leadership: (snapshot?.leadership || []).map((row) => ({
            squad_key: row.squad_key,
            captain_player_id: row.captain_player_id || null,
            vice_captain_player_id: row.vice_captain_player_id || null,
        })).sort((a, b) => String(a.squad_key).localeCompare(String(b.squad_key))),
    });
}

function signaturesEqual(left, right) {
    return JSON.stringify(operationalSignature(left)) === JSON.stringify(operationalSignature(right));
}

async function findReservationConflicts(db, playerId, desiredReservations) {
    if (!desiredReservations?.length || !await tableExists(db, 'slot_reservations')) return [];
    const conflicts = [];
    for (const reservation of desiredReservations) {
        const row = await db.get(
            'SELECT id, player_id, status FROM slot_reservations WHERE id = ? AND player_id = ?',
            [reservation.id, playerId]
        );
        if (!row) {
            conflicts.push({ type: 'reservation_missing', reservationId: reservation.id });
            continue;
        }
        const occupied = await db.get(
            `SELECT id, player_id, status
             FROM slot_reservations
             WHERE player_id <> ?
               AND category = ?
               AND option_key = ?
               AND status IN ('pending', 'confirmed')
             ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END, id
             LIMIT 1`,
            [playerId, reservation.category, reservation.option_key]
        );
        if (occupied) {
            conflicts.push({
                type: 'reservation_occupied',
                reservationId: reservation.id,
                category: reservation.category,
                optionKey: reservation.option_key,
                occupiedBy: occupied.player_id,
            });
        }
    }
    return conflicts;
}

async function findQueueConflicts(db, playerId, desiredQueue) {
    if (!desiredQueue?.length || !await tableExists(db, 'clover_spell_review_queue')) return [];
    const conflicts = [];
    for (const entry of desiredQueue) {
        const row = await db.get(
            'SELECT id FROM clover_spell_review_queue WHERE id = ? AND player_id = ?',
            [entry.id, playerId]
        );
        if (!row) conflicts.push({ type: 'queue_entry_missing', queueId: entry.id });
    }
    if (desiredQueue.some((entry) => entry.status === 'called')) {
        const called = await db.get(
            `SELECT id, player_id
             FROM clover_spell_review_queue
             WHERE status = 'called'
               AND player_id <> ?
             ORDER BY id LIMIT 1`,
            [playerId]
        );
        if (called) conflicts.push({ type: 'another_player_called', queueId: called.id, playerId: called.player_id });
    }
    return conflicts;
}

async function findLeadershipConflicts(db, playerId, desiredLeadership) {
    if (!desiredLeadership?.length || !await tableExists(db, 'clover_squads')) return [];
    const conflicts = [];
    for (const desired of desiredLeadership) {
        const current = await db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [desired.squad_key]);
        if (!current) {
            conflicts.push({ type: 'squad_missing', squadKey: desired.squad_key });
            continue;
        }
        if (desired.captain_player_id === playerId && current.captain_player_id && current.captain_player_id !== playerId) {
            conflicts.push({ type: 'captain_occupied', squadKey: desired.squad_key, occupiedBy: current.captain_player_id });
        }
        if (desired.vice_captain_player_id === playerId && current.vice_captain_player_id && current.vice_captain_player_id !== playerId) {
            conflicts.push({ type: 'vice_occupied', squadKey: desired.squad_key, occupiedBy: current.vice_captain_player_id });
        }
    }
    return conflicts;
}

async function findSquadConflict(db, desiredPlayer) {
    const squad = desiredPlayer?.esquadrao;
    if (isEmptyValue(squad) || !await tableExists(db, 'clover_squads')) return [];
    const expected = normalizeCompact(squad);
    const rows = await db.all('SELECT squad_key, name FROM clover_squads');
    const exists = (rows || []).some((row) => (
        normalizeCompact(row.squad_key) === expected || normalizeCompact(row.name) === expected
    ));
    return exists ? [] : [{ type: 'player_squad_missing', squad }];
}

async function previewLifecycleUndo(db, sourceCode) {
    await ensurePlayerLifecycleUndoSchema(db);
    const resolved = await resolveLifecycleEventCode(db, sourceCode);
    if (!resolved.ok) return resolved;
    const event = resolved.event;

    if (event.undone_at || event.undo_operation_code) {
        return {
            ok: false,
            code: 'already_undone',
            error: `O evento ${event.operation_code} já foi desfeito por ${event.undo_operation_code || '-'}.`,
            event,
        };
    }

    const latest = await db.get(
        `SELECT * FROM clover_player_lifecycle_events
         WHERE player_id = ?
         ORDER BY id DESC LIMIT 1`,
        [event.player_id]
    );
    if (!latest || latest.id !== event.id) {
        return {
            ok: false,
            code: 'not_latest_lifecycle_event',
            error: 'Só é possível desfazer o evento mais recente desse player.',
            event,
            latest,
        };
    }

    const expectedCurrent = safeJsonParse(event.after_json, null);
    const desired = safeJsonParse(event.before_json, null);
    if (!expectedCurrent?.player || !desired?.player) {
        return { ok: false, code: 'invalid_lifecycle_snapshot', error: 'Snapshot do evento está inválido.', event };
    }

    const current = await captureLifecycleSnapshot(db, event.player_id);
    if (!current?.player) return { ok: false, code: 'player_not_found', error: 'Player do evento não existe mais.', event };
    if (!signaturesEqual(current, expectedCurrent)) {
        return {
            ok: false,
            code: 'state_drift_detected',
            error: 'O estado do player mudou depois desse evento. O desfazer foi bloqueado para não sobrescrever alterações posteriores.',
            event,
            current,
            expectedCurrent,
        };
    }

    const conflicts = [
        ...await findReservationConflicts(db, event.player_id, desired.reservations || []),
        ...await findQueueConflicts(db, event.player_id, desired.queueEntries || []),
        ...await findLeadershipConflicts(db, event.player_id, desired.leadership || []),
        ...await findSquadConflict(db, desired.player),
    ];
    if (conflicts.length) {
        return {
            ok: false,
            code: 'undo_conflicts',
            error: `Desfazer bloqueado por ${conflicts.length} conflito(s).`,
            event,
            conflicts,
            current,
            desired,
        };
    }

    return {
        ok: true,
        sourceCode: resolved.sourceCode,
        simulationCode: resolved.simulationCode || null,
        event,
        current,
        desired,
        conflicts: [],
        changes: {
            lifecycleStatus: [current.player.lifecycle_status || 'active', desired.player.lifecycle_status || 'active'],
            gameStatus: [current.player.jogo_status || '-', desired.player.jogo_status || '-'],
            squad: [current.player.esquadrao || '-', desired.player.esquadrao || '-'],
            queueEntries: [current.queueEntries.length, desired.queueEntries?.length || 0],
            reservations: [current.reservations.length, desired.reservations?.length || 0],
            leadership: [current.leadership.length, desired.leadership?.length || 0],
        },
    };
}

async function restorePlayer(db, desiredPlayer, playerId) {
    await db.run(
        `UPDATE jogadores
         SET lifecycle_status = ?,
             jogo_status = ?,
             esquadrao = ?,
             archived_at = ?,
             archived_by = ?,
             archive_reason = ?,
             reactivated_at = ?,
             reactivated_by = ?
         WHERE id = ?`,
        [
            desiredPlayer.lifecycle_status || 'active',
            desiredPlayer.jogo_status || 'bloqueado',
            desiredPlayer.esquadrao || '-',
            desiredPlayer.archived_at || null,
            desiredPlayer.archived_by || null,
            desiredPlayer.archive_reason || null,
            desiredPlayer.reactivated_at || null,
            desiredPlayer.reactivated_by || null,
            playerId,
        ]
    );
}

async function restoreReservations(db, playerId, desiredReservations) {
    if (!await tableExists(db, 'slot_reservations')) return { released: 0, restored: 0 };
    const released = await db.run(
        `UPDATE slot_reservations
         SET status = 'released'
         WHERE player_id = ? AND status IN ('pending', 'confirmed')`,
        [playerId]
    );
    let restored = 0;
    for (const reservation of desiredReservations || []) {
        const result = await db.run(
            `UPDATE slot_reservations
             SET status = ?
             WHERE id = ? AND player_id = ?`,
            [reservation.status, reservation.id, playerId]
        );
        restored += Number(result?.changes || 0);
    }
    return { released: Number(released?.changes || 0), restored };
}

async function restoreQueue(db, playerId, desiredQueue, actorId, reason) {
    if (!await tableExists(db, 'clover_spell_review_queue')) return { closed: 0, restored: 0 };
    const closed = await db.run(
        `UPDATE clover_spell_review_queue
         SET status = 'removed',
             closed_at = CURRENT_TIMESTAMP,
             closed_by = ?,
             reason = ?
         WHERE player_id = ? AND status IN ('waiting', 'called')`,
        [actorId || null, `desfazer ciclo: ${reason}`, playerId]
    );
    let restored = 0;
    for (const entry of desiredQueue || []) {
        const result = await db.run(
            `UPDATE clover_spell_review_queue
             SET status = ?,
                 requested_at = ?,
                 called_at = ?,
                 closed_at = ?,
                 closed_by = ?,
                 reason = ?
             WHERE id = ? AND player_id = ?`,
            [
                entry.status,
                entry.requested_at || null,
                entry.called_at || null,
                entry.closed_at || null,
                entry.closed_by || null,
                entry.reason || null,
                entry.id,
                playerId,
            ]
        );
        restored += Number(result?.changes || 0);
    }
    return { closed: Number(closed?.changes || 0), restored };
}

async function restoreLeadership(db, playerId, desiredLeadership) {
    if (!await tableExists(db, 'clover_squads')) return { cleared: 0, restored: 0 };
    const columns = await tableColumns(db, 'clover_squads');
    let cleared = 0;
    let restored = 0;
    if (columns.has('captain_player_id')) {
        const result = await db.run(
            `UPDATE clover_squads SET captain_player_id = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE captain_player_id = ?`,
            [playerId]
        );
        cleared += Number(result?.changes || 0);
    }
    if (columns.has('vice_captain_player_id')) {
        const result = await db.run(
            `UPDATE clover_squads SET vice_captain_player_id = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE vice_captain_player_id = ?`,
            [playerId]
        );
        cleared += Number(result?.changes || 0);
    }

    for (const row of desiredLeadership || []) {
        if (columns.has('captain_player_id') && row.captain_player_id === playerId) {
            const result = await db.run(
                `UPDATE clover_squads SET captain_player_id = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE squad_key = ?`,
                [playerId, row.squad_key]
            );
            restored += Number(result?.changes || 0);
        }
        if (columns.has('vice_captain_player_id') && row.vice_captain_player_id === playerId) {
            const result = await db.run(
                `UPDATE clover_squads SET vice_captain_player_id = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE squad_key = ?`,
                [playerId, row.squad_key]
            );
            restored += Number(result?.changes || 0);
        }
    }
    return { cleared, restored };
}

async function applyLifecycleUndo(db, {
    sourceCode,
    reason,
    actorId = null,
    operationCode = null,
} = {}) {
    if (!reason || String(reason).trim().length < 3) {
        return { ok: false, code: 'missing_reason', error: 'Desfazer precisa de motivo.' };
    }
    await ensurePlayerLifecycleUndoSchema(db);
    const code = operationCode || generateUndoCode();

    await db.exec('BEGIN IMMEDIATE');
    try {
        const preview = await previewLifecycleUndo(db, sourceCode);
        if (!preview.ok) {
            await db.exec('ROLLBACK');
            return preview;
        }

        const beforeUndo = preview.current;
        const desired = preview.desired;
        await restorePlayer(db, desired.player, preview.event.player_id);
        const reservations = await restoreReservations(db, preview.event.player_id, desired.reservations || []);
        const queue = await restoreQueue(db, preview.event.player_id, desired.queueEntries || [], actorId, reason);
        const leadership = await restoreLeadership(db, preview.event.player_id, desired.leadership || []);
        const restored = await captureLifecycleSnapshot(db, preview.event.player_id);
        const result = {
            sourceEvent: preview.event.operation_code,
            sourceType: preview.event.operation_type,
            reservations,
            queue,
            leadership,
            antiGhostRestored: false,
        };

        await db.run(
            `INSERT INTO clover_player_lifecycle_undos
             (operation_code, source_event_id, source_operation_code, player_id,
              reason, created_by, before_undo_json, restored_json, result_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                code,
                preview.event.id,
                preview.event.operation_code,
                preview.event.player_id,
                String(reason).trim(),
                actorId,
                serialize(beforeUndo),
                serialize(restored),
                serialize(result),
            ]
        );
        await db.run(
            `UPDATE clover_player_lifecycle_events
             SET undone_at = CURRENT_TIMESTAMP,
                 undone_by = ?,
                 undo_reason = ?,
                 undo_operation_code = ?
             WHERE id = ?`,
            [actorId, String(reason).trim(), code, preview.event.id]
        );

        await db.exec('COMMIT');
        return {
            ok: true,
            code,
            sourceCode: preview.sourceCode,
            event: preview.event,
            playerId: preview.event.player_id,
            beforeUndo,
            restored,
            result,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    applyLifecycleUndo,
    ensurePlayerLifecycleUndoSchema,
    generateUndoCode,
    operationalSignature,
    previewLifecycleUndo,
    resolveLifecycleEventCode,
    signaturesEqual,
};
