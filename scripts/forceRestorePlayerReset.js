'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    RESET_DELETE_TABLES,
    RESET_PLAYER_DEFAULTS,
    captureResetSnapshot,
    ensurePlayerResetSchema,
} = require('../helpers/clover/playerResetService');
const {
    assertGlobalResetChildRestoreAllowed,
    syncGlobalParentAfterChildRestore,
} = require('../helpers/clover/globalResetChildRestoreSync');

const REQUIRED_CONFIRMATION = 'FORCE_RESTORE_OLD_CHARACTER';

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function parseJson(value, fallback = null) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
        [tableName]
    );
    return Boolean(row?.found);
}

async function tableInfo(db, tableName) {
    if (!await tableExists(db, tableName)) return [];
    return db.all(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
}

async function tableColumns(db, tableName) {
    return new Set((await tableInfo(db, tableName)).map((row) => row.name));
}

async function selectRowsByPlayer(db, tableName, playerId) {
    if (!await tableExists(db, tableName)) return [];
    const columns = await tableColumns(db, tableName);
    if (!columns.has('player_id')) return [];
    return db.all(
        `SELECT * FROM ${quoteIdentifier(tableName)} WHERE player_id = ? ORDER BY rowid`,
        [playerId]
    ).catch(() => db.all(
        `SELECT * FROM ${quoteIdentifier(tableName)} WHERE player_id = ?`,
        [playerId]
    ));
}

async function insertSnapshotRows(db, tableName, rows) {
    if (!rows?.length) return 0;
    const info = await tableInfo(db, tableName);
    if (!info.length) throw new Error(`Tabela ausente durante restauração: ${tableName}`);
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
    if (!row || !await tableExists(db, tableName)) return 0;
    const columns = await tableColumns(db, tableName);
    const keys = keyColumns.filter((column) => columns.has(column));
    const mutable = Object.keys(row).filter((column) => columns.has(column) && !keys.includes(column));
    if (!keys.length || !mutable.length) return 0;

    const result = await db.run(
        `UPDATE ${quoteIdentifier(tableName)}
         SET ${mutable.map((column) => `${quoteIdentifier(column)} = ?`).join(', ')}
         WHERE ${keys.map((column) => `${quoteIdentifier(column)} = ?`).join(' AND ')}`,
        [...mutable.map((column) => row[column]), ...keys.map((column) => row[column])]
    );
    return Number(result?.changes || 0);
}

async function findRestoreConflicts(db, playerId, desired) {
    const conflicts = [];

    for (const [tableName, rows] of Object.entries(desired.tables || {})) {
        if (rows.length && !await tableExists(db, tableName)) {
            conflicts.push({ type: 'restore_table_missing', table: tableName, rows: rows.length });
        }
    }

    if ((desired.queueEntries || []).length) {
        if (!await tableExists(db, 'clover_spell_review_queue')) {
            conflicts.push({ type: 'queue_table_missing' });
        } else {
            for (const row of desired.queueEntries) {
                const existing = await db.get(
                    'SELECT id FROM clover_spell_review_queue WHERE id = ? AND player_id = ?',
                    [row.id, playerId]
                );
                if (!existing) conflicts.push({ type: 'queue_entry_missing', queueId: row.id });
            }
            if (desired.queueEntries.some((row) => row.status === 'called')) {
                const occupied = await db.get(
                    `SELECT id, player_id FROM clover_spell_review_queue
                     WHERE status = 'called' AND player_id <> ? ORDER BY id LIMIT 1`,
                    [playerId]
                );
                if (occupied) conflicts.push({ type: 'another_player_called', ...occupied });
            }
        }
    }

    if ((desired.reservations || []).length) {
        if (!await tableExists(db, 'slot_reservations')) {
            conflicts.push({ type: 'reservation_table_missing' });
        } else {
            for (const row of desired.reservations) {
                const existing = await db.get(
                    'SELECT id FROM slot_reservations WHERE id = ? AND player_id = ?',
                    [row.id, playerId]
                );
                if (!existing) {
                    conflicts.push({ type: 'reservation_missing', reservationId: row.id });
                    continue;
                }
                const occupied = await db.get(
                    `SELECT id, player_id FROM slot_reservations
                     WHERE player_id <> ? AND category = ? AND option_key = ?
                       AND status IN ('pending', 'confirmed')
                     ORDER BY id LIMIT 1`,
                    [playerId, row.category, row.option_key]
                );
                if (occupied) {
                    conflicts.push({
                        type: 'reservation_occupied',
                        reservationId: row.id,
                        category: row.category,
                        optionKey: row.option_key,
                        occupiedBy: occupied.player_id,
                    });
                }
            }
        }
    }

    if ((desired.leadership || []).length) {
        if (!await tableExists(db, 'clover_squads')) {
            conflicts.push({ type: 'squad_table_missing' });
        } else {
            for (const row of desired.leadership) {
                const current = await db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [row.squad_key]);
                if (!current) {
                    conflicts.push({ type: 'squad_missing', squadKey: row.squad_key });
                    continue;
                }
                if (row.captain_player_id === playerId && current.captain_player_id && current.captain_player_id !== playerId) {
                    conflicts.push({ type: 'captain_occupied', squadKey: row.squad_key, occupiedBy: current.captain_player_id });
                }
                if (row.vice_captain_player_id === playerId && current.vice_captain_player_id && current.vice_captain_player_id !== playerId) {
                    conflicts.push({ type: 'vice_occupied', squadKey: row.squad_key, occupiedBy: current.vice_captain_player_id });
                }
            }
        }
    }

    return conflicts;
}

async function restorePlayerFields(db, playerId, playerSnapshot, { releaseGame = false, actorId = null } = {}) {
    const columns = await tableColumns(db, 'jogadores');
    const values = new Map();

    for (const column of Object.keys(RESET_PLAYER_DEFAULTS)) {
        if (columns.has(column)) values.set(column, playerSnapshot[column] ?? null);
    }

    if (releaseGame) {
        if (columns.has('jogo_status')) values.set('jogo_status', 'liberado');
        if (columns.has('lifecycle_status')) values.set('lifecycle_status', 'active');
        if (columns.has('jogo_bloqueio_motivo')) values.set('jogo_bloqueio_motivo', null);
        if (columns.has('jogo_liberado_by')) values.set('jogo_liberado_by', actorId || null);
    }

    const entries = [...values.entries()];
    const assignments = entries.map(([column]) => `${quoteIdentifier(column)} = ?`);
    if (releaseGame && columns.has('jogo_liberado_at')) {
        assignments.push(`${quoteIdentifier('jogo_liberado_at')} = CURRENT_TIMESTAMP`);
    }

    const result = await db.run(
        `UPDATE jogadores SET ${assignments.join(', ')} WHERE id = ?`,
        [...entries.map(([, value]) => value), playerId]
    );
    if (Number(result?.changes || 0) !== 1) throw new Error(`Cadastro principal não encontrado: ${playerId}`);
}

async function restoreLeadership(db, playerId, rows) {
    if (!await tableExists(db, 'clover_squads')) return 0;
    const columns = await tableColumns(db, 'clover_squads');
    let restored = 0;

    if (columns.has('captain_player_id')) {
        await db.run('UPDATE clover_squads SET captain_player_id = NULL WHERE captain_player_id = ?', [playerId]);
    }
    if (columns.has('vice_captain_player_id')) {
        await db.run('UPDATE clover_squads SET vice_captain_player_id = NULL WHERE vice_captain_player_id = ?', [playerId]);
    }

    for (const row of rows || []) {
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

async function restoreArchive(db, record) {
    if (!record || !await tableExists(db, 'clover_archive_cards')) return 0;
    const existing = await db.get('SELECT player_id FROM clover_archive_cards WHERE player_id = ?', [record.player_id]);
    if (existing) return restoreExistingRow(db, 'clover_archive_cards', record, ['player_id']);
    return insertSnapshotRows(db, 'clover_archive_cards', [record]);
}

function snapshotCounts(snapshot) {
    return Object.fromEntries(
        RESET_DELETE_TABLES.map((tableName) => [tableName, snapshot?.tables?.[tableName]?.length || 0])
    );
}

async function loadPreview(db, { playerId, sourceCode }) {
    await ensurePlayerResetSchema(db);
    const event = await db.get(
        'SELECT * FROM clover_player_reset_events WHERE operation_code = ?',
        [String(sourceCode || '').trim().toUpperCase()]
    );
    if (!event) return { ok: false, code: 'reset_not_found', error: `Reset ${sourceCode} não encontrado.` };
    if (event.player_id !== playerId) {
        return { ok: false, code: 'wrong_player', error: `O reset pertence a ${event.player_id}.`, event };
    }
    if (event.status === 'restored' || event.restored_at || event.restore_operation_code) {
        return { ok: false, code: 'already_restored', error: 'Esse reset já foi restaurado.', event };
    }
    const latest = await db.get(
        'SELECT * FROM clover_player_reset_events WHERE player_id = ? ORDER BY id DESC LIMIT 1',
        [playerId]
    );
    if (!latest || latest.id !== event.id) {
        return { ok: false, code: 'not_latest_reset', error: 'Esse não é o reset mais recente do player.', event, latest };
    }

    const desired = parseJson(event.before_json, null);
    if (!desired?.player) return { ok: false, code: 'invalid_snapshot', error: 'Snapshot antigo inválido.', event };
    const current = await captureResetSnapshot(db, playerId);
    if (!current?.player) return { ok: false, code: 'player_missing', error: 'Cadastro canônico não existe.', event };

    let globalParent;
    try {
        globalParent = await assertGlobalResetChildRestoreAllowed(db, {
            resetOperationCode: event.operation_code,
            playerId,
        });
    } catch (error) {
        return {
            ok: false,
            code: error?.code || 'global_reset_child_restore_blocked',
            error: error?.message || String(error),
            details: error?.details || null,
            event,
        };
    }

    const conflicts = await findRestoreConflicts(db, playerId, desired);

    return {
        ok: conflicts.length === 0,
        code: conflicts.length ? 'restore_conflicts' : null,
        error: conflicts.length ? 'Existem conflitos externos que impedem a recuperação.' : null,
        event,
        desired,
        current,
        conflicts,
        currentCounts: snapshotCounts(current),
        desiredCounts: snapshotCounts(desired),
        globalParent,
    };
}

async function forceRestorePlayerReset(db, {
    playerId,
    sourceCode,
    reason,
    actorId = null,
    operationCode = null,
    releaseGame = false,
} = {}) {
    if (!reason || String(reason).trim().length < 3) {
        return { ok: false, code: 'missing_reason', error: 'Informe o motivo da recuperação.' };
    }

    const preview = await loadPreview(db, { playerId, sourceCode });
    if (!preview.ok) return preview;
    const restoreCode = operationCode || `RR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    await db.exec('BEGIN IMMEDIATE');
    try {
        const fresh = await loadPreview(db, { playerId, sourceCode });
        if (!fresh.ok) {
            await db.exec('ROLLBACK');
            return fresh;
        }

        const { event, desired, current, globalParent } = fresh;
        await restorePlayerFields(db, playerId, desired.player, { releaseGame, actorId });

        const insertedByTable = {};
        const discardedByTable = {};
        for (const tableName of RESET_DELETE_TABLES) {
            if (!await tableExists(db, tableName)) continue;
            const columns = await tableColumns(db, tableName);
            if (!columns.has('player_id')) continue;
            const deleted = await db.run(
                `DELETE FROM ${quoteIdentifier(tableName)} WHERE player_id = ?`,
                [playerId]
            );
            if (Number(deleted?.changes || 0)) discardedByTable[tableName] = Number(deleted.changes);
            const inserted = await insertSnapshotRows(db, tableName, desired.tables?.[tableName] || []);
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
        const leadershipRestored = await restoreLeadership(db, playerId, desired.leadership || []);
        const archiveRestored = await restoreArchive(db, desired.archiveRecord);
        const restored = await captureResetSnapshot(db, playerId);

        for (const tableName of RESET_DELETE_TABLES) {
            const expected = desired.tables?.[tableName]?.length || 0;
            const actual = restored.tables?.[tableName]?.length || 0;
            if (expected !== actual) {
                throw new Error(`${tableName}: esperado ${expected}, restaurado ${actual}.`);
            }
        }

        if (restored.player.personagem_nome !== desired.player.personagem_nome) {
            throw new Error('O nome do personagem não corresponde ao snapshot antigo.');
        }
        if (restored.player.magia !== desired.player.magia || restored.player.grimorio !== desired.player.grimorio) {
            throw new Error('Magia ou grimório não correspondem ao snapshot antigo.');
        }
        if (releaseGame && restored.player.jogo_status !== 'liberado') {
            throw new Error('O jogo não ficou liberado após a restauração.');
        }

        const foreignKeys = await db.all('PRAGMA foreign_key_check');
        if (foreignKeys.length) throw new Error(`foreign_key_check encontrou ${foreignKeys.length} falha(s).`);
        const integrity = await db.all('PRAGMA integrity_check');
        const integrityFailures = integrity
            .flatMap((row) => Object.values(row))
            .filter((value) => String(value).toLowerCase() !== 'ok');
        if (integrityFailures.length) throw new Error(`integrity_check falhou: ${integrityFailures.join('; ')}`);

        const result = {
            forced: true,
            releaseGame,
            discardedByTable,
            insertedByTable,
            discardedRows: Object.values(discardedByTable).reduce((sum, value) => sum + Number(value || 0), 0),
            insertedRows: Object.values(insertedByTable).reduce((sum, value) => sum + Number(value || 0), 0),
            queueRestored,
            reservationsRestored,
            leadershipRestored,
            archiveRestored,
        };

        await db.run(
            `INSERT INTO clover_player_reset_restores
             (operation_code, source_event_id, source_operation_code, player_id, reason,
              created_by, before_restore_json, restored_json, result_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [
                restoreCode,
                event.id,
                event.operation_code,
                playerId,
                String(reason).trim(),
                actorId,
                JSON.stringify(current),
                JSON.stringify(restored),
                JSON.stringify(result),
            ]
        );
        const eventUpdate = await db.run(
            `UPDATE clover_player_reset_events
             SET status = 'restored', restored_at = CURRENT_TIMESTAMP, restored_by = ?,
                 restore_reason = ?, restore_operation_code = ?
             WHERE id = ? AND status = 'applied'`,
            [actorId, String(reason).trim(), restoreCode, event.id]
        );
        if (Number(eventUpdate?.changes || 0) !== 1) {
            const error = new Error('Evento de reset não foi marcado como restored exatamente uma vez.');
            error.code = 'reset_restore_event_compare_and_swap_failed';
            throw error;
        }

        const globalParentSync = await syncGlobalParentAfterChildRestore(db, {
            resetOperationCode: event.operation_code,
            playerId,
            restoreOperationCode: restoreCode,
            actorId,
            reason: String(reason).trim(),
            resolvedParent: globalParent,
        });

        await db.exec('COMMIT');
        return {
            ok: true,
            code: restoreCode,
            sourceCode: event.operation_code,
            playerId,
            desired,
            beforeRestore: current,
            restored,
            result,
            globalParentSync,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

function summary(snapshot) {
    const player = snapshot?.player || {};
    const counts = snapshotCounts(snapshot);
    return {
        personagem: player.personagem_nome || '-',
        ficha: player.ficha_status || '-',
        historia: player.historia_status || '-',
        aparencia: player.personagem_aparencia_status || '-',
        jogo: player.jogo_status || '-',
        magia: player.magia || '-',
        grimorio: player.grimorio || '-',
        rolls: counts.player_rolls || 0,
        tentativas: counts.clover_trait_attempts || 0,
        ph: counts.clover_ph_ledger || 0,
        inventario: counts.clover_inventory_items || 0,
        feiticos: counts.clover_spellbook_spells || 0,
    };
}

async function cli() {
    const args = process.argv.slice(2);
    const value = (name, fallback = null) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
    const database = path.resolve(value('db', 'banco.sqlite'));
    const playerId = value('player');
    const sourceCode = String(value('reset', '')).toUpperCase();
    const apply = args.includes('--apply');
    const releaseGame = args.includes('--release-game');
    const confirmation = value('confirm', '');
    const outputDir = path.resolve(value('output', 'backups'));

    if (!playerId || !sourceCode) throw new Error('Use --player=<id> e --reset=RS-....');
    if (apply && confirmation !== REQUIRED_CONFIRMATION) {
        throw new Error(`Aplicação exige --confirm=${REQUIRED_CONFIRMATION}`);
    }

    const db = await open({ filename: database, driver: sqlite3.Database });
    let report;
    try {
        await db.exec('PRAGMA foreign_keys = ON');
        await db.exec('PRAGMA busy_timeout = 15000');
        const preview = await loadPreview(db, { playerId, sourceCode });
        if (!preview.ok) {
            console.error('\nRECUPERAÇÃO BLOQUEADA:');
            console.error(JSON.stringify({ code: preview.code, error: preview.error, conflicts: preview.conflicts || [] }, null, 2));
            process.exitCode = 2;
            report = { mode: apply ? 'apply' : 'preview', ok: false, preview };
        } else {
            console.log('\n=== RECUPERAÇÃO FORÇADA DE RESET ===');
            console.log(`Modo: ${apply ? 'APLICAÇÃO' : 'PRÉVIA SOMENTE LEITURA'}`);
            console.log(`Player: ${playerId}`);
            console.log(`Reset: ${sourceCode}`);
            console.log('\nEstado parcial que será arquivado e substituído:');
            console.table([summary(preview.current)]);
            console.log('\nSnapshot antigo que será restaurado:');
            console.table([summary(preview.desired)]);

            if (!apply) {
                console.log(`\nPara aplicar: --apply --confirm=${REQUIRED_CONFIRMATION}`);
                report = { mode: 'preview', ok: true, preview };
            } else {
                const restored = await forceRestorePlayerReset(db, {
                    playerId,
                    sourceCode,
                    reason: value('reason', 'Recuperação do personagem antigo após reset acidental'),
                    actorId: value('actor', 'manual-force-reset-recovery'),
                    releaseGame,
                });
                if (!restored.ok) throw new Error(restored.error || restored.code || 'Restauração falhou.');
                console.log('\n=== PERSONAGEM RECUPERADO ===');
                console.table([summary(restored.restored)]);
                console.log(`Código de recuperação: ${restored.code}`);
                console.log(`Registros parciais descartados: ${restored.result.discardedRows}`);
                console.log(`Registros antigos restaurados: ${restored.result.insertedRows}`);
                console.log(`Jogo liberado: ${releaseGame ? 'SIM' : 'NÃO ALTERADO'}`);
                report = { mode: 'apply', ok: true, restored };
            }
        }
    } finally {
        await db.close();
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportFile = path.join(outputDir, `forced-player-reset-recovery-${stamp}.json`);
    fs.writeFileSync(reportFile, JSON.stringify({ generatedAt: new Date().toISOString(), database, ...report }, null, 2));
    console.log(`Relatório: ${reportFile}`);
}

if (require.main === module) {
    cli().catch((error) => {
        console.error('\nFALHA NA RECUPERAÇÃO FORÇADA:');
        console.error(error.stack || error.message || error);
        process.exitCode = 1;
    });
}

module.exports = {
    REQUIRED_CONFIRMATION,
    forceRestorePlayerReset,
    loadPreview,
    snapshotCounts,
    summary,
};
