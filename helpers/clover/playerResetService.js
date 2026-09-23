const crypto = require('crypto');

const { normalizeText } = require('../textUtils');
const { ensureCloverScriptSchema } = require('./cloverScriptService');

const RESET_DELETE_TABLES = [
    'pending_profile_confirmations',
    'pending_magic_confirmations',
    'clover_pending_skill_purchases',
    'clover_pending_hexagon_upgrades',
    'clover_trait_attempts',
    'clover_appearance_reviews',
    'clover_skill_nodes',
    'clover_inventory_items',
    'clover_quick_evaluations',
    'clover_ph_ledger',
    'clover_mana_hexagon_ledger',
    'clover_mana_hexagon',
    'clover_character_stats',
    'player_rolls',
    'player_skill_trees',
    'player_progress',
    'player_onboarding',
    'clover_spellbook_spells',
    'clover_character_bonuses',
    'clover_return_bonuses',
];

const RESET_PLAYER_DEFAULTS = {
    idade: '-',
    reino: '-',
    classe: '-',
    familia: '-',
    raca: '-',
    grimorio: '-',
    magia: '-',
    formas: '-',
    historia: '-',
    aparencia: '-',
    dinheiro: 0,
    esquadrao: '-',
    estrelas: 0,
    atributos_max: 10,
    forca: 0,
    velocidade: 0,
    resistencia: 0,
    reflexos: 0,
    poder_magico: 0,
    mana: 0,
    pontos: 5,
    agilidade: 0,
    personagem_nome: '-',
    personagem_idade: null,
    personagem_aparencia: '-',
    personagem_aparencia_normalizada: null,
    personagem_aparencia_status: 'pending',
    personagem_aparencia_motivo: null,
    personagem_aparencia_image_path: null,
    personagem_aparencia_image_message_id: null,
    personagem_aparencia_approved_by: null,
    personagem_aparencia_approved_at: null,
    personagem_aparencia_updated_at: null,
    personagem_genero: '-',
    numero_roll_escolhido: null,
    ficha_status: 'incompleta',
    ultima_recepcao_em: null,
    familia_key: null,
    magia_key: null,
    aptidao_comum: '-',
    aptidao_comum_key: null,
    marca_comum: '-',
    marca_comum_key: null,
    aptidao_rara: '-',
    aptidao_rara_key: null,
    marca_rara: '-',
    marca_rara_key: null,
    anomalia: '-',
    anomalia_key: null,
    tentativas_especiais: '[]',
    roll_sacrifice_used: 0,
    roll_sacrifice_used_at: null,
    historia_status: 'pendente',
    historia_status_updated_at: null,
    historia_aprovada_at: null,
    historia_aprovada_by: null,
    historia_pv_sent_at: null,
    historia_motivo: null,
    gancho_narrativo: '-',
    historias_extras: '[]',
    jogo_status: 'bloqueado',
    jogo_liberado_at: null,
    jogo_liberado_by: null,
    jogo_bloqueio_motivo: 'reset seguro',
    patente: '-',
    lifecycle_status: 'active',
    archived_at: null,
    archived_by: null,
    archive_reason: null,
    reactivated_at: null,
    reactivated_by: null,
};

class PlayerResetError extends Error {
    constructor(message, code = 'player_reset_error', details = null) {
        super(message);
        this.name = 'PlayerResetError';
        this.code = code;
        this.details = details || null;
    }
}

function generateResetCode() {
    return `RS-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function generateRestoreCode() {
    return `RR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function serialize(value) {
    return JSON.stringify(value ?? null);
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

function normalizeCompact(value) {
    return normalizeText(String(value || ''))
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isEmptyCharacter(value) {
    const normalized = normalizeCompact(value);
    return !normalized || ['-', 'nenhum', 'na', 'n a', 'null', 'undefined'].includes(normalized);
}

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT 1 AS found FROM sqlite_master
         WHERE type = 'table' AND name = ? LIMIT 1`,
        [tableName]
    );
    return Boolean(row?.found);
}

async function tableInfo(db, tableName) {
    if (!await tableExists(db, tableName)) return [];
    return db.all(`PRAGMA table_info(${quoteIdentifier(tableName)})`).catch(() => []);
}

async function tableColumns(db, tableName) {
    return new Set((await tableInfo(db, tableName)).map((row) => row.name));
}

async function addColumnIfMissing(db, tableName, columnName, definition) {
    const columns = await tableColumns(db, tableName);
    if (columns.has(columnName)) return false;
    await db.exec(`ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${quoteIdentifier(columnName)} ${definition}`);
    return true;
}

async function ensurePlayerResetSchema(db) {
    await ensureCloverScriptSchema(db);
    if (!await tableExists(db, 'jogadores')) throw new Error('Tabela jogadores não existe.');

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_player_reset_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation_code TEXT NOT NULL UNIQUE,
            player_id TEXT NOT NULL,
            scope TEXT NOT NULL DEFAULT 'character',
            reason TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'applied'
                CHECK (status IN ('applied', 'restored')),
            created_by TEXT DEFAULT NULL,
            before_json TEXT NOT NULL,
            after_json TEXT NOT NULL,
            result_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            restored_at TEXT DEFAULT NULL,
            restored_by TEXT DEFAULT NULL,
            restore_reason TEXT DEFAULT NULL,
            restore_operation_code TEXT DEFAULT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_clover_player_reset_events_player
        ON clover_player_reset_events (player_id, id DESC);

        CREATE TABLE IF NOT EXISTS clover_player_reset_restores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation_code TEXT NOT NULL UNIQUE,
            source_event_id INTEGER NOT NULL UNIQUE,
            source_operation_code TEXT NOT NULL,
            player_id TEXT NOT NULL,
            reason TEXT NOT NULL,
            created_by TEXT DEFAULT NULL,
            before_restore_json TEXT NOT NULL,
            restored_json TEXT NOT NULL,
            result_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_clover_player_reset_restores_player
        ON clover_player_reset_restores (player_id, id DESC);
    `);

    await addColumnIfMissing(db, 'clover_player_reset_events', 'restored_at', 'TEXT DEFAULT NULL');
    await addColumnIfMissing(db, 'clover_player_reset_events', 'restored_by', 'TEXT DEFAULT NULL');
    await addColumnIfMissing(db, 'clover_player_reset_events', 'restore_reason', 'TEXT DEFAULT NULL');
    await addColumnIfMissing(db, 'clover_player_reset_events', 'restore_operation_code', 'TEXT DEFAULT NULL');
}

async function selectRowsByPlayer(db, tableName, playerId) {
    if (!await tableExists(db, tableName)) return [];
    const columns = await tableColumns(db, tableName);
    if (!columns.has('player_id')) return [];
    return db.all(
        `SELECT * FROM ${quoteIdentifier(tableName)} WHERE player_id = ? ORDER BY rowid`,
        [playerId]
    ).catch(async () => db.all(
        `SELECT * FROM ${quoteIdentifier(tableName)} WHERE player_id = ?`,
        [playerId]
    ));
}

async function getActiveQueueRows(db, playerId) {
    if (!await tableExists(db, 'clover_spell_review_queue')) return [];
    return db.all(
        `SELECT * FROM clover_spell_review_queue
         WHERE player_id = ? AND status IN ('waiting', 'called')
         ORDER BY id`,
        [playerId]
    );
}

async function getActiveReservationRows(db, playerId) {
    if (!await tableExists(db, 'slot_reservations')) return [];
    return db.all(
        `SELECT * FROM slot_reservations
         WHERE player_id = ? AND status IN ('pending', 'confirmed')
         ORDER BY id`,
        [playerId]
    );
}

async function getLeadershipRows(db, playerId) {
    if (!await tableExists(db, 'clover_squads')) return [];
    const columns = await tableColumns(db, 'clover_squads');
    const predicates = [];
    const params = [];
    if (columns.has('captain_player_id')) {
        predicates.push('captain_player_id = ?');
        params.push(playerId);
    }
    if (columns.has('vice_captain_player_id')) {
        predicates.push('vice_captain_player_id = ?');
        params.push(playerId);
    }
    if (!predicates.length) return [];
    return db.all(
        `SELECT * FROM clover_squads WHERE ${predicates.join(' OR ')} ORDER BY squad_key`,
        params
    );
}

async function getAntiGhostRow(db, playerId) {
    if (!await tableExists(db, 'clover_antighost_activity')) return null;
    return db.get('SELECT * FROM clover_antighost_activity WHERE player_id = ?', [playerId]);
}

async function getArchiveRecord(db, playerId) {
    if (!await tableExists(db, 'clover_archive_cards')) return null;
    return db.get('SELECT * FROM clover_archive_cards WHERE player_id = ?', [playerId]);
}

async function captureResetSnapshot(db, playerId) {
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    if (!player) return null;

    const tables = {};
    for (const tableName of RESET_DELETE_TABLES) {
        const rows = await selectRowsByPlayer(db, tableName, playerId);
        if (rows.length) tables[tableName] = rows;
    }

    const [queueEntries, reservations, leadership, antiGhost, archiveRecord] = await Promise.all([
        getActiveQueueRows(db, playerId),
        getActiveReservationRows(db, playerId),
        getLeadershipRows(db, playerId),
        getAntiGhostRow(db, playerId),
        getArchiveRecord(db, playerId),
    ]);

    return {
        capturedAt: new Date().toISOString(),
        player,
        tables,
        queueEntries,
        reservations,
        leadership,
        antiGhost,
        archiveRecord,
    };
}

function validateResetPlayer(player) {
    if (!player) return { ok: false, code: 'player_not_found', error: 'Player não encontrado.' };
    if (Number(player.is_shadow || 0) === 1) {
        return { ok: false, code: 'shadow_player', error: 'Cadastro sombra não pode ser resetado. Use o cadastro canônico.' };
    }
    if (isEmptyCharacter(player.personagem_nome)) {
        return { ok: false, code: 'missing_character', error: 'O cadastro não possui personagem ativo para resetar.' };
    }
    return { ok: true };
}

function snapshotCounts(snapshot) {
    const tables = Object.fromEntries(
        Object.entries(snapshot?.tables || {}).map(([table, rows]) => [table, rows.length])
    );
    return {
        tables,
        deletedRows: Object.values(tables).reduce((total, value) => total + Number(value || 0), 0),
        queueEntriesClosed: snapshot?.queueEntries?.length || 0,
        reservationsReleased: snapshot?.reservations?.length || 0,
        leadershipRolesCleared: (snapshot?.leadership || []).reduce((total, row) => (
            total
            + (row.captain_player_id === snapshot.player.id ? 1 : 0)
            + (row.vice_captain_player_id === snapshot.player.id ? 1 : 0)
        ), 0),
    };
}

async function previewResetPlayer(db, playerId) {
    await ensurePlayerResetSchema(db);
    const snapshot = await captureResetSnapshot(db, playerId);
    const validation = validateResetPlayer(snapshot?.player || null);
    if (!validation.ok) return { ...validation, snapshot };
    return {
        ok: true,
        player: snapshot.player,
        counts: snapshotCounts(snapshot),
        preserved: {
            playerId: true,
            personalIdentity: true,
            aliases: true,
            adminHistory: true,
            groupMembership: true,
            antiGhostActivity: true,
            returnPoints: true,
            returnShopEntitlements: true,
        },
    };
}

async function updatePlayerForReset(db, playerId, reason) {
    const columns = await tableColumns(db, 'jogadores');
    const entries = Object.entries(RESET_PLAYER_DEFAULTS)
        .filter(([column]) => columns.has(column))
        .map(([column, value]) => [column, column === 'jogo_bloqueio_motivo' ? `reset seguro: ${String(reason).trim()}` : value]);
    if (!entries.length) return 0;
    const assignments = entries.map(([column]) => `${quoteIdentifier(column)} = ?`).join(', ');
    const result = await db.run(
        `UPDATE jogadores SET ${assignments} WHERE id = ?`,
        [...entries.map(([, value]) => value), playerId]
    );
    return Number(result?.changes || 0);
}

async function clearLeadership(db, playerId) {
    if (!await tableExists(db, 'clover_squads')) return 0;
    const columns = await tableColumns(db, 'clover_squads');
    let changes = 0;
    if (columns.has('captain_player_id')) {
        const result = await db.run(
            `UPDATE clover_squads SET captain_player_id = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE captain_player_id = ?`,
            [playerId]
        );
        changes += Number(result?.changes || 0);
    }
    if (columns.has('vice_captain_player_id')) {
        const result = await db.run(
            `UPDATE clover_squads SET vice_captain_player_id = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE vice_captain_player_id = ?`,
            [playerId]
        );
        changes += Number(result?.changes || 0);
    }
    return changes;
}

async function resetAntiGhostRisk(db, playerId) {
    if (!await tableExists(db, 'clover_antighost_activity')) return 0;
    const columns = await tableColumns(db, 'clover_antighost_activity');
    const desired = {
        last_activity_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
        last_activity_kind: 'character_reset',
        candidate_at: null,
        last_notice_level: null,
        last_notice_at: null,
        exempt_until: null,
        exempt_reason: null,
        updated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    };
    const entries = Object.entries(desired).filter(([column]) => columns.has(column));
    if (!entries.length) return 0;
    const result = await db.run(
        `UPDATE clover_antighost_activity
         SET ${entries.map(([column]) => `${quoteIdentifier(column)} = ?`).join(', ')}
         WHERE player_id = ?`,
        [...entries.map(([, value]) => value), playerId]
    );
    return Number(result?.changes || 0);
}

async function markArchiveDeleted(db, playerId) {
    if (!await tableExists(db, 'clover_archive_cards')) return 0;
    const columns = await tableColumns(db, 'clover_archive_cards');
    if (!columns.has('status')) return 0;
    const assignments = ['status = ?'];
    const params = ['deleted'];
    if (columns.has('updated_at')) assignments.push('updated_at = CURRENT_TIMESTAMP');
    const result = await db.run(
        `UPDATE clover_archive_cards SET ${assignments.join(', ')} WHERE player_id = ?`,
        [...params, playerId]
    );
    return Number(result?.changes || 0);
}

async function resetPlayer(db, { playerId, reason, actorId = null, operationCode = null } = {}) {
    if (!reason || String(reason).trim().length < 3) {
        return { ok: false, code: 'missing_reason', error: 'Reset precisa de motivo.' };
    }
    await ensurePlayerResetSchema(db);
    const preview = await previewResetPlayer(db, playerId);
    if (!preview.ok) return preview;

    const code = operationCode || generateResetCode();
    await db.exec('BEGIN IMMEDIATE');
    try {
        const freshPlayer = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
        const validation = validateResetPlayer(freshPlayer);
        if (!validation.ok) {
            await db.exec('ROLLBACK');
            return validation;
        }

        const before = await captureResetSnapshot(db, playerId);
        const deletedByTable = {};
        await updatePlayerForReset(db, playerId, reason);

        for (const tableName of RESET_DELETE_TABLES) {
            if (!await tableExists(db, tableName)) continue;
            const columns = await tableColumns(db, tableName);
            if (!columns.has('player_id')) continue;
            const result = await db.run(
                `DELETE FROM ${quoteIdentifier(tableName)} WHERE player_id = ?`,
                [playerId]
            );
            if (Number(result?.changes || 0) > 0) deletedByTable[tableName] = Number(result.changes);
        }

        let queueClosed = 0;
        if (await tableExists(db, 'clover_spell_review_queue')) {
            const result = await db.run(
                `UPDATE clover_spell_review_queue
                 SET status = 'removed', closed_at = CURRENT_TIMESTAMP, closed_by = ?, reason = ?
                 WHERE player_id = ? AND status IN ('waiting', 'called')`,
                [actorId, `reset seguro: ${String(reason).trim()}`, playerId]
            );
            queueClosed = Number(result?.changes || 0);
        }

        let reservationsReleased = 0;
        if (await tableExists(db, 'slot_reservations')) {
            const result = await db.run(
                `UPDATE slot_reservations SET status = 'released'
                 WHERE player_id = ? AND status IN ('pending', 'confirmed')`,
                [playerId]
            );
            reservationsReleased = Number(result?.changes || 0);
        }

        const leadershipCleared = await clearLeadership(db, playerId);
        const antiGhostReset = await resetAntiGhostRisk(db, playerId);
        const archiveMarkedDeleted = await markArchiveDeleted(db, playerId);
        const after = await captureResetSnapshot(db, playerId);
        const result = {
            deletedByTable,
            deletedRows: Object.values(deletedByTable).reduce((total, value) => total + Number(value || 0), 0),
            queueClosed,
            reservationsReleased,
            leadershipCleared,
            antiGhostReset,
            archiveMarkedDeleted,
            preserved: {
                playerId: true,
                personalIdentity: true,
                aliases: true,
                adminHistory: true,
                groupMembership: true,
                returnPoints: true,
                returnShopEntitlements: true,
            },
        };

        await db.run(
            `INSERT INTO clover_player_reset_events
             (operation_code, player_id, scope, reason, status, created_by,
              before_json, after_json, result_json, created_at)
             VALUES (?, ?, 'character', ?, 'applied', ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
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
        return { ok: true, code, playerId, before, after, result };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value ?? null;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function resetPlayerFields(player) {
    return Object.fromEntries(
        Object.keys(RESET_PLAYER_DEFAULTS).sort().map((column) => [column, player?.[column] ?? null])
    );
}

function operationalSignature(snapshot) {
    const tableCounts = Object.fromEntries(
        RESET_DELETE_TABLES.map((tableName) => [tableName, snapshot?.tables?.[tableName]?.length || 0])
    );
    return stable({
        playerId: snapshot?.player?.id || null,
        player: resetPlayerFields(snapshot?.player || {}),
        tableCounts,
        queueEntries: (snapshot?.queueEntries || []).map((row) => ({ id: row.id, status: row.status })).sort((a, b) => Number(a.id) - Number(b.id)),
        reservations: (snapshot?.reservations || []).map((row) => ({ id: row.id, status: row.status })).sort((a, b) => Number(a.id) - Number(b.id)),
        leadership: (snapshot?.leadership || []).map((row) => ({
            squad_key: row.squad_key,
            captain_player_id: row.captain_player_id || null,
            vice_captain_player_id: row.vice_captain_player_id || null,
        })).sort((a, b) => String(a.squad_key).localeCompare(String(b.squad_key))),
        archiveStatus: snapshot?.archiveRecord?.status || null,
    });
}

function signaturesEqual(left, right) {
    return JSON.stringify(operationalSignature(left)) === JSON.stringify(operationalSignature(right));
}

async function resolveResetEvent(db, rawCode) {
    await ensurePlayerResetSchema(db);
    const code = String(rawCode || '').trim().toUpperCase();
    if (!code) return { ok: false, code: 'missing_reset_code', error: 'Informe o código RS-... do reset.' };
    if (!code.startsWith('RS-')) {
        return { ok: false, code: 'unsupported_reset_code', error: `Código ${code} não é um reset recuperável.` };
    }
    const event = await db.get('SELECT * FROM clover_player_reset_events WHERE operation_code = ?', [code]);
    return event
        ? { ok: true, event }
        : { ok: false, code: 'reset_not_found', error: `Reset ${code} não encontrado.` };
}

async function findRestoreConflicts(db, playerId, desired) {
    const conflicts = [];

    if (await tableExists(db, 'slot_reservations')) {
        for (const reservation of desired.reservations || []) {
            const row = await db.get(
                'SELECT id FROM slot_reservations WHERE id = ? AND player_id = ?',
                [reservation.id, playerId]
            );
            if (!row) {
                conflicts.push({ type: 'reservation_missing', reservationId: reservation.id });
                continue;
            }
            const occupied = await db.get(
                `SELECT id, player_id FROM slot_reservations
                 WHERE player_id <> ? AND category = ? AND option_key = ?
                   AND status IN ('pending', 'confirmed')
                 ORDER BY id LIMIT 1`,
                [playerId, reservation.category, reservation.option_key]
            );
            if (occupied) {
                conflicts.push({
                    type: 'reservation_occupied',
                    reservationId: reservation.id,
                    occupiedBy: occupied.player_id,
                    category: reservation.category,
                    optionKey: reservation.option_key,
                });
            }
        }
    } else if ((desired.reservations || []).length) {
        conflicts.push({ type: 'reservation_table_missing' });
    }

    if (await tableExists(db, 'clover_spell_review_queue')) {
        for (const entry of desired.queueEntries || []) {
            const row = await db.get(
                'SELECT id FROM clover_spell_review_queue WHERE id = ? AND player_id = ?',
                [entry.id, playerId]
            );
            if (!row) conflicts.push({ type: 'queue_entry_missing', queueId: entry.id });
        }
        if ((desired.queueEntries || []).some((entry) => entry.status === 'called')) {
            const called = await db.get(
                `SELECT id, player_id FROM clover_spell_review_queue
                 WHERE status = 'called' AND player_id <> ? ORDER BY id LIMIT 1`,
                [playerId]
            );
            if (called) conflicts.push({ type: 'another_player_called', queueId: called.id, occupiedBy: called.player_id });
        }
    } else if ((desired.queueEntries || []).length) {
        conflicts.push({ type: 'queue_table_missing' });
    }

    if ((desired.leadership || []).length) {
        if (!await tableExists(db, 'clover_squads')) {
            conflicts.push({ type: 'squad_table_missing' });
        } else {
            for (const leadership of desired.leadership) {
                const current = await db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [leadership.squad_key]);
                if (!current) {
                    conflicts.push({ type: 'squad_missing', squadKey: leadership.squad_key });
                    continue;
                }
                if (leadership.captain_player_id === playerId && current.captain_player_id && current.captain_player_id !== playerId) {
                    conflicts.push({ type: 'captain_occupied', squadKey: leadership.squad_key, occupiedBy: current.captain_player_id });
                }
                if (leadership.vice_captain_player_id === playerId && current.vice_captain_player_id && current.vice_captain_player_id !== playerId) {
                    conflicts.push({ type: 'vice_occupied', squadKey: leadership.squad_key, occupiedBy: current.vice_captain_player_id });
                }
            }
        }
    }

    for (const [tableName, rows] of Object.entries(desired.tables || {})) {
        if (rows.length && !await tableExists(db, tableName)) {
            conflicts.push({ type: 'restore_table_missing', table: tableName, rows: rows.length });
        }
    }

    return conflicts;
}

async function previewRestoreReset(db, sourceCode) {
    const resolved = await resolveResetEvent(db, sourceCode);
    if (!resolved.ok) return resolved;
    const event = resolved.event;
    if (event.status === 'restored' || event.restored_at || event.restore_operation_code) {
        return {
            ok: false,
            code: 'reset_already_restored',
            error: `O reset ${event.operation_code} já foi restaurado por ${event.restore_operation_code || '-'}.`,
            event,
        };
    }

    const latest = await db.get(
        `SELECT * FROM clover_player_reset_events
         WHERE player_id = ? ORDER BY id DESC LIMIT 1`,
        [event.player_id]
    );
    if (!latest || latest.id !== event.id) {
        return { ok: false, code: 'not_latest_reset', error: 'Só é possível restaurar o reset mais recente desse player.', event, latest };
    }

    const desired = safeJsonParse(event.before_json, null);
    const expectedCurrent = safeJsonParse(event.after_json, null);
    if (!desired?.player || !expectedCurrent?.player) {
        return { ok: false, code: 'invalid_reset_snapshot', error: 'Snapshot do reset está inválido.', event };
    }
    const current = await captureResetSnapshot(db, event.player_id);
    if (!current?.player) return { ok: false, code: 'player_missing', error: 'O cadastro canônico não existe mais.', event };
    if (!signaturesEqual(current, expectedCurrent)) {
        return {
            ok: false,
            code: 'state_changed_after_reset',
            error: 'O player já recebeu dados novos depois do reset. A restauração automática foi bloqueada.',
            event,
            current,
            expectedCurrent,
        };
    }

    const conflicts = await findRestoreConflicts(db, event.player_id, desired);
    return {
        ok: conflicts.length === 0,
        code: conflicts.length ? 'restore_conflicts' : null,
        error: conflicts.length ? 'Existem conflitos que impedem a restauração segura.' : null,
        event,
        desired,
        current,
        conflicts,
        counts: snapshotCounts(desired),
    };
}

async function updatePlayerFromSnapshot(db, playerId, playerSnapshot) {
    const columns = await tableColumns(db, 'jogadores');
    const entries = Object.keys(RESET_PLAYER_DEFAULTS)
        .filter((column) => columns.has(column))
        .map((column) => [column, playerSnapshot[column] ?? null]);
    if (!entries.length) return 0;
    const result = await db.run(
        `UPDATE jogadores SET ${entries.map(([column]) => `${quoteIdentifier(column)} = ?`).join(', ')} WHERE id = ?`,
        [...entries.map(([, value]) => value), playerId]
    );
    return Number(result?.changes || 0);
}

async function insertSnapshotRows(db, tableName, rows) {
    if (!rows?.length) return 0;
    const info = await tableInfo(db, tableName);
    if (!info.length) throw new PlayerResetError(`Tabela ${tableName} não existe para restauração.`, 'restore_table_missing', { table: tableName });
    const columns = new Set(info.map((row) => row.name));
    let inserted = 0;
    for (const row of rows) {
        const names = Object.keys(row).filter((column) => columns.has(column));
        if (!names.length) continue;
        await db.run(
            `INSERT INTO ${quoteIdentifier(tableName)}
             (${names.map(quoteIdentifier).join(', ')})
             VALUES (${names.map(() => '?').join(', ')})`,
            names.map((column) => row[column])
        );
        inserted += 1;
    }
    return inserted;
}

async function restoreExistingRow(db, tableName, row, keyColumns) {
    if (!row) return 0;
    const columns = await tableColumns(db, tableName);
    const mutable = Object.keys(row).filter((column) => columns.has(column) && !keyColumns.includes(column));
    const where = keyColumns.filter((column) => columns.has(column));
    if (!mutable.length || !where.length) return 0;
    const result = await db.run(
        `UPDATE ${quoteIdentifier(tableName)}
         SET ${mutable.map((column) => `${quoteIdentifier(column)} = ?`).join(', ')}
         WHERE ${where.map((column) => `${quoteIdentifier(column)} = ?`).join(' AND ')}`,
        [...mutable.map((column) => row[column]), ...where.map((column) => row[column])]
    );
    return Number(result?.changes || 0);
}

async function restoreLeadership(db, playerId, rows) {
    let restored = 0;
    for (const row of rows || []) {
        const columns = await tableColumns(db, 'clover_squads');
        const assignments = [];
        const params = [];
        if (columns.has('captain_player_id') && row.captain_player_id === playerId) {
            assignments.push('captain_player_id = ?');
            params.push(playerId);
        }
        if (columns.has('vice_captain_player_id') && row.vice_captain_player_id === playerId) {
            assignments.push('vice_captain_player_id = ?');
            params.push(playerId);
        }
        if (!assignments.length) continue;
        if (columns.has('updated_at')) assignments.push('updated_at = CURRENT_TIMESTAMP');
        const result = await db.run(
            `UPDATE clover_squads SET ${assignments.join(', ')} WHERE squad_key = ?`,
            [...params, row.squad_key]
        );
        restored += Number(result?.changes || 0);
    }
    return restored;
}

async function restoreArchiveRecord(db, record) {
    if (!record) return 0;
    const existing = await db.get('SELECT player_id FROM clover_archive_cards WHERE player_id = ?', [record.player_id]);
    if (existing) return restoreExistingRow(db, 'clover_archive_cards', record, ['player_id']);
    return insertSnapshotRows(db, 'clover_archive_cards', [record]);
}

async function restorePlayerReset(db, { sourceCode, reason, actorId = null, operationCode = null } = {}) {
    if (!reason || String(reason).trim().length < 3) {
        return { ok: false, code: 'missing_reason', error: 'Restauração precisa de motivo.' };
    }
    await ensurePlayerResetSchema(db);
    const preview = await previewRestoreReset(db, sourceCode);
    if (!preview.ok) return preview;

    const code = operationCode || generateRestoreCode();
    await db.exec('BEGIN IMMEDIATE');
    try {
        const fresh = await previewRestoreReset(db, sourceCode);
        if (!fresh.ok) {
            await db.exec('ROLLBACK');
            return fresh;
        }
        const { event, desired } = fresh;
        const beforeRestore = await captureResetSnapshot(db, event.player_id);
        await updatePlayerFromSnapshot(db, event.player_id, desired.player);

        const insertedByTable = {};
        for (const [tableName, rows] of Object.entries(desired.tables || {})) {
            const inserted = await insertSnapshotRows(db, tableName, rows);
            if (inserted) insertedByTable[tableName] = inserted;
        }

        let queueRestored = 0;
        for (const row of desired.queueEntries || []) {
            queueRestored += await restoreExistingRow(db, 'clover_spell_review_queue', row, ['id', 'player_id']);
        }
        let reservationsRestored = 0;
        for (const row of desired.reservations || []) {
            reservationsRestored += await restoreExistingRow(db, 'slot_reservations', row, ['id', 'player_id']);
        }
        const leadershipRestored = await restoreLeadership(db, event.player_id, desired.leadership || []);
        const archiveRestored = await restoreArchiveRecord(db, desired.archiveRecord);
        const restored = await captureResetSnapshot(db, event.player_id);
        const result = {
            insertedByTable,
            insertedRows: Object.values(insertedByTable).reduce((total, value) => total + Number(value || 0), 0),
            queueRestored,
            reservationsRestored,
            leadershipRestored,
            archiveRestored,
            antiGhostActivityPreserved: true,
        };

        await db.run(
            `INSERT INTO clover_player_reset_restores
             (operation_code, source_event_id, source_operation_code, player_id, reason,
              created_by, before_restore_json, restored_json, result_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [
                code,
                event.id,
                event.operation_code,
                event.player_id,
                String(reason).trim(),
                actorId,
                serialize(beforeRestore),
                serialize(restored),
                serialize(result),
            ]
        );
        await db.run(
            `UPDATE clover_player_reset_events
             SET status = 'restored', restored_at = CURRENT_TIMESTAMP, restored_by = ?,
                 restore_reason = ?, restore_operation_code = ?
             WHERE id = ?`,
            [actorId, String(reason).trim(), code, event.id]
        );

        await db.exec('COMMIT');
        return {
            ok: true,
            code,
            sourceCode: event.operation_code,
            playerId: event.player_id,
            beforeRestore,
            restored,
            result,
            event,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    PlayerResetError,
    RESET_DELETE_TABLES,
    RESET_PLAYER_DEFAULTS,
    captureResetSnapshot,
    ensurePlayerResetSchema,
    generateResetCode,
    generateRestoreCode,
    operationalSignature,
    previewResetPlayer,
    previewRestoreReset,
    resetPlayer,
    resolveResetEvent,
    restorePlayerReset,
    signaturesEqual,
    snapshotCounts,
};
