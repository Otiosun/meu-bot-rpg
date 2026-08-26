'use strict';

const crypto = require('crypto');
const { isOwner, normalizeJid } = require('../groupAccess');
const { captureResetSnapshot, ensurePlayerResetSchema, previewResetPlayer, resetPlayer } = require('./playerResetService');

const OP_TABLE = 'clover_global_player_reset_operations';
const ITEM_TABLE = 'clover_global_player_reset_items';
const LOCK_TABLE = 'clover_global_player_reset_lock';
const LOCK_KEY = 'global_character_reset';
const FAILURE_POLICY = 'stop_on_first_error';

class GlobalPlayerResetError extends Error {
    constructor(message, code = 'global_player_reset_error', details = null) {
        super(message || code);
        this.name = 'GlobalPlayerResetError';
        this.code = code;
        this.details = details || null;
    }
}

function generateOperationId() {
    return `GR-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value ?? null;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function snapshotHash(snapshot) {
    if (!snapshot) return sha256('null');
    const { capturedAt, ...rest } = snapshot;
    return sha256(JSON.stringify(stable(rest)));
}

function childResetOperationCode(operationId, playerId) {
    return `RS-G-${sha256(`${operationId}|${playerId}`).slice(0, 20).toUpperCase()}`;
}

function normalizePlayerIds(values) {
    return [...new Set((values || [])
        .map((value) => normalizeJid(value) || String(value || '').trim())
        .filter(Boolean))]
        .sort();
}

function assertOwner(actorId) {
    if (!isOwner(actorId)) {
        throw new GlobalPlayerResetError('Reset global exige Owner canônico.', 'global_reset_permission_denied');
    }
}

function assertApplyKillSwitches(operationId) {
    if (String(process.env.CLOVER_GLOBAL_RESET_ENABLED || '').trim().toUpperCase() !== 'YES') {
        throw new GlobalPlayerResetError('Kill switch global está OFF.', 'global_reset_kill_switch_off');
    }
    if (String(process.env.CLOVER_GLOBAL_RESET_OPERATION_ID || '').trim() !== operationId) {
        throw new GlobalPlayerResetError('Operation ID não está pinado no ambiente.', 'global_reset_operation_not_pinned');
    }
    if (String(process.env.CLOVER_RESET_EXECUTION_AUTHORIZED || '').trim().toUpperCase() !== 'YES') {
        throw new GlobalPlayerResetError(
            'Autorização operacional final do RESET está ausente.',
            'global_reset_execution_not_authorized'
        );
    }
}

async function ensureGlobalPlayerResetSchema(db) {
    await ensurePlayerResetSchema(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS ${OP_TABLE} (
            operation_id TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned','running','paused','completed','reconciled','aborted')),
            failure_policy TEXT NOT NULL DEFAULT '${FAILURE_POLICY}'
                CHECK (failure_policy = '${FAILURE_POLICY}'),
            reason TEXT NOT NULL,
            created_by TEXT NOT NULL,
            selection_source TEXT NOT NULL,
            population_hash TEXT NOT NULL,
            selected_count INTEGER NOT NULL,
            expected_count INTEGER NOT NULL,
            applied_count INTEGER NOT NULL DEFAULT 0,
            failed_count INTEGER NOT NULL DEFAULT 0,
            skipped_count INTEGER NOT NULL DEFAULT 0,
            reconciled_count INTEGER NOT NULL DEFAULT 0,
            execution_token TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            started_at TEXT DEFAULT NULL,
            completed_at TEXT DEFAULT NULL,
            reconciled_at TEXT DEFAULT NULL,
            aborted_at TEXT DEFAULT NULL,
            last_error_json TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS ${ITEM_TABLE} (
            operation_id TEXT NOT NULL,
            player_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            status TEXT NOT NULL
                CHECK (status IN ('pending','processing','applied','failed','skipped','reconciled')),
            reset_operation_code TEXT NOT NULL UNIQUE,
            planned_snapshot_sha256 TEXT DEFAULT NULL,
            preview_json TEXT DEFAULT NULL,
            result_json TEXT DEFAULT NULL,
            last_error_json TEXT DEFAULT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            started_at TEXT DEFAULT NULL,
            finished_at TEXT DEFAULT NULL,
            PRIMARY KEY (operation_id, player_id),
            FOREIGN KEY (operation_id) REFERENCES ${OP_TABLE}(operation_id)
        );

        CREATE INDEX IF NOT EXISTS idx_global_player_reset_items_status
        ON ${ITEM_TABLE} (operation_id, status, ordinal);

        CREATE TABLE IF NOT EXISTS ${LOCK_TABLE} (
            lock_key TEXT PRIMARY KEY,
            operation_id TEXT NOT NULL UNIQUE,
            acquired_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (operation_id) REFERENCES ${OP_TABLE}(operation_id)
        );
    `);
}

async function discoverTechnicalResetCandidates(db) {
    await ensureGlobalPlayerResetSchema(db);
    const columns = new Set((await db.all('PRAGMA table_info(jogadores)')).map((row) => row.name));
    const where = [];
    if (columns.has('is_shadow')) where.push('COALESCE(is_shadow, 0) = 0');
    if (columns.has('merged_into')) where.push("(merged_into IS NULL OR TRIM(merged_into) = '')");
    if (columns.has('identity_status')) where.push("COALESCE(identity_status, 'active') = 'active'");
    if (columns.has('lifecycle_status')) where.push("COALESCE(lifecycle_status, 'active') = 'active'");
    const rows = await db.all(`SELECT id FROM jogadores ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`);
    return {
        write: false,
        authoritativeSelection: false,
        note: 'Inventário técnico; D09/session eligibility continua externa e unresolved.',
        playerIds: rows.map((row) => row.id),
    };
}

async function readResetEvent(db, resetOperationCode) {
    return db.get(
        `SELECT id, operation_code, player_id, status, result_json
         FROM clover_player_reset_events WHERE operation_code = ?`,
        [resetOperationCode]
    );
}

function populationHash(items) {
    return sha256(JSON.stringify(items.map((item) => ({
        playerId: item.playerId,
        status: item.status,
        snapshotSha256: item.snapshotSha256,
        resetOperationCode: item.resetOperationCode,
    }))));
}

async function refreshCounters(db, operationId) {
    const row = await db.get(`
        SELECT
            SUM(CASE WHEN status <> 'skipped' THEN 1 ELSE 0 END) AS expected_count,
            SUM(CASE WHEN status IN ('applied','reconciled') THEN 1 ELSE 0 END) AS applied_count,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
            SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count,
            SUM(CASE WHEN status = 'reconciled' THEN 1 ELSE 0 END) AS reconciled_count
        FROM ${ITEM_TABLE} WHERE operation_id = ?`, [operationId]);
    const counts = {
        expectedCount: Number(row?.expected_count || 0),
        appliedCount: Number(row?.applied_count || 0),
        failedCount: Number(row?.failed_count || 0),
        skippedCount: Number(row?.skipped_count || 0),
        reconciledCount: Number(row?.reconciled_count || 0),
    };
    await db.run(
        `UPDATE ${OP_TABLE} SET expected_count=?, applied_count=?, failed_count=?, skipped_count=?, reconciled_count=?
         WHERE operation_id=?`,
        [counts.expectedCount, counts.appliedCount, counts.failedCount, counts.skippedCount, counts.reconciledCount, operationId]
    );
    return counts;
}

async function getGlobalPlayerResetOperation(db, operationId) {
    await ensureGlobalPlayerResetSchema(db);
    const operation = await db.get(`SELECT * FROM ${OP_TABLE} WHERE operation_id=?`, [operationId]);
    if (!operation) throw new GlobalPlayerResetError('Operação global não encontrada.', 'global_reset_operation_not_found');
    const items = await db.all(`SELECT * FROM ${ITEM_TABLE} WHERE operation_id=? ORDER BY ordinal`, [operationId]);
    return { operation, items };
}

async function planGlobalPlayerReset(db, { actorId, reason, playerIds, selectionSource, operationId = null, metadata = null } = {}) {
    assertOwner(actorId);
    const cleanReason = String(reason || '').trim().replace(/\s+/g, ' ');
    const source = String(selectionSource || '').trim().replace(/\s+/g, ' ');
    if (cleanReason.length < 8) throw new GlobalPlayerResetError('Motivo detalhado obrigatório.', 'global_reset_reason_required');
    if (source.length < 3) throw new GlobalPlayerResetError('Origem da seleção obrigatória.', 'global_reset_selection_source_required');
    const selectedIds = normalizePlayerIds(playerIds);
    if (!selectedIds.length) throw new GlobalPlayerResetError('População explícita obrigatória.', 'global_reset_population_required');

    await ensureGlobalPlayerResetSchema(db);
    const id = operationId || generateOperationId();
    await db.exec('BEGIN IMMEDIATE');
    try {
        const lock = await db.get(`SELECT * FROM ${LOCK_TABLE} WHERE lock_key=?`, [LOCK_KEY]);
        if (lock) throw new GlobalPlayerResetError(`Ciclo global já bloqueado por ${lock.operation_id}.`, 'global_reset_cycle_locked', lock);
        if (await db.get(`SELECT 1 AS found FROM ${OP_TABLE} WHERE operation_id=?`, [id])) {
            throw new GlobalPlayerResetError('Operation ID já existe.', 'global_reset_operation_exists');
        }

        const items = [];
        for (let index = 0; index < selectedIds.length; index += 1) {
            const playerId = selectedIds[index];
            const player = await db.get('SELECT * FROM jogadores WHERE id=?', [playerId]);
            if (!player) throw new GlobalPlayerResetError(`Player selecionado ausente: ${playerId}.`, 'global_reset_selected_player_missing');
            if (Number(player.is_shadow || 0) === 1) throw new GlobalPlayerResetError(`Shadow selecionado: ${playerId}.`, 'global_reset_shadow_selected');

            const childPreview = await previewResetPlayer(db, playerId);
            if (!childPreview.ok && childPreview.code !== 'missing_character') {
                throw new GlobalPlayerResetError(
                    `Player não passou no preview canônico do reset: ${playerId}.`,
                    'global_reset_child_preview_rejected',
                    { playerId, code: childPreview.code || 'unknown', error: childPreview.error || null }
                );
            }
            const snapshot = childPreview.ok
                ? await captureResetSnapshot(db, playerId)
                : childPreview.snapshot;
            const status = childPreview.ok ? 'pending' : 'skipped';
            const character = String(snapshot?.player?.personagem_nome || '').trim();
            items.push({
                playerId,
                ordinal: index + 1,
                status,
                snapshotSha256: snapshotHash(snapshot),
                resetOperationCode: childResetOperationCode(id, playerId),
                preview: { playerId, activeCharacter: status === 'pending', personagemNome: character || null },
            });
        }

        const hash = populationHash(items);
        const expectedCount = items.filter((item) => item.status === 'pending').length;
        const skippedCount = items.length - expectedCount;
        if (!expectedCount) {
            throw new GlobalPlayerResetError(
                'Dry-run global não encontrou nenhum personagem ativo para resetar.',
                'global_reset_empty_effective_population',
                { selectedCount: items.length, skippedCount }
            );
        }
        await db.run(
            `INSERT INTO ${OP_TABLE}
             (operation_id,status,failure_policy,reason,created_by,selection_source,population_hash,selected_count,expected_count,skipped_count,metadata_json)
             VALUES (?,'planned',?,?,?,?,?,?,?,?,?)`,
            [id, FAILURE_POLICY, cleanReason, normalizeJid(actorId) || String(actorId), source, hash, items.length, expectedCount, skippedCount, JSON.stringify(metadata ?? null)]
        );
        for (const item of items) {
            await db.run(
                `INSERT INTO ${ITEM_TABLE}
                 (operation_id,player_id,ordinal,status,reset_operation_code,planned_snapshot_sha256,preview_json)
                 VALUES (?,?,?,?,?,?,?)`,
                [id, item.playerId, item.ordinal, item.status, item.resetOperationCode, item.snapshotSha256, JSON.stringify(item.preview)]
            );
        }
        await db.run(`INSERT INTO ${LOCK_TABLE} (lock_key,operation_id) VALUES (?,?)`, [LOCK_KEY, id]);
        await db.exec('COMMIT');
        return { ok: true, dryRun: true, write: true, mutatedPlayers: false, operationId: id, failurePolicy: FAILURE_POLICY, populationHash: hash, selectedCount: items.length, expectedCount, skippedCount, items };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function markItem(db, operationId, playerId, patch) {
    const entries = Object.entries(patch);
    await db.run(
        `UPDATE ${ITEM_TABLE} SET ${entries.map(([key]) => `${key}=?`).join(', ')} WHERE operation_id=? AND player_id=?`,
        [...entries.map(([, value]) => value), operationId, playerId]
    );
}

async function applyGlobalPlayerReset(db, { operationId, actorId } = {}) {
    assertOwner(actorId);
    if (!operationId) throw new GlobalPlayerResetError('operationId obrigatório.', 'global_reset_operation_id_required');
    assertApplyKillSwitches(operationId);
    await ensureGlobalPlayerResetSchema(db);

    const token = `GX-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
    await db.exec('BEGIN IMMEDIATE');
    try {
        const op = await db.get(`SELECT * FROM ${OP_TABLE} WHERE operation_id=?`, [operationId]);
        if (!op) throw new GlobalPlayerResetError('Operação não encontrada.', 'global_reset_operation_not_found');
        if (!['planned','paused'].includes(op.status)) throw new GlobalPlayerResetError(`Status inválido: ${op.status}.`, 'global_reset_invalid_status');
        if (op.execution_token) throw new GlobalPlayerResetError('Executor já ativo/órfão.', 'global_reset_execution_locked');
        await db.run(`UPDATE ${OP_TABLE} SET status='running',execution_token=?,started_at=COALESCE(started_at,CURRENT_TIMESTAMP),last_error_json=NULL WHERE operation_id=?`, [token, operationId]);
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }

    try {
        const { operation, items } = await getGlobalPlayerResetOperation(db, operationId);
        const journalHash = populationHash(items.map((item) => ({
            playerId: item.player_id,
            status: item.status === 'skipped' ? 'skipped' : 'pending',
            snapshotSha256: item.planned_snapshot_sha256,
            resetOperationCode: item.reset_operation_code,
        })));
        if (journalHash !== operation.population_hash) throw new GlobalPlayerResetError('Journal congelado divergiu do hash.', 'global_reset_population_journal_drift');

        // Revalida a coorte inteira antes da primeira mutação. Drift já existente => zero players mutados.
        for (const item of items) {
            if (item.status === 'skipped') continue;
            const existingEvent = await readResetEvent(db, item.reset_operation_code);
            if (existingEvent) continue;
            const preflightSha = snapshotHash(await captureResetSnapshot(db, item.player_id));
            if (preflightSha !== item.planned_snapshot_sha256) {
                const details = { playerId: item.player_id, expectedSha256: item.planned_snapshot_sha256, actualSha256: preflightSha, phase: 'cohort_preflight' };
                await markItem(db, operationId, item.player_id, { status: 'failed', last_error_json: JSON.stringify(details), finished_at: new Date().toISOString() });
                await refreshCounters(db, operationId);
                throw new GlobalPlayerResetError(`Coorte mudou desde o dry-run: ${item.player_id}.`, 'global_reset_planned_state_drift', details);
            }
        }

        for (const item of items) {
            if (item.status === 'skipped') continue;
            const event = await readResetEvent(db, item.reset_operation_code);
            if (event) {
                if (event.player_id !== item.player_id || event.status !== 'applied') {
                    throw new GlobalPlayerResetError('Evento filho divergente.', 'global_reset_child_event_mismatch', { playerId: item.player_id, event });
                }
                await markItem(db, operationId, item.player_id, { status: 'reconciled', result_json: event.result_json || null, last_error_json: null, finished_at: new Date().toISOString() });
                continue;
            }

            const currentSha = snapshotHash(await captureResetSnapshot(db, item.player_id));
            if (currentSha !== item.planned_snapshot_sha256) {
                const details = { playerId: item.player_id, expectedSha256: item.planned_snapshot_sha256, actualSha256: currentSha };
                await markItem(db, operationId, item.player_id, { status: 'failed', last_error_json: JSON.stringify(details), finished_at: new Date().toISOString() });
                await refreshCounters(db, operationId);
                throw new GlobalPlayerResetError(`Estado mudou desde o dry-run: ${item.player_id}.`, 'global_reset_planned_state_drift', details);
            }

            await markItem(db, operationId, item.player_id, { status: 'processing', attempt_count: Number(item.attempt_count || 0) + 1, started_at: new Date().toISOString(), last_error_json: null });
            let result;
            try {
                result = await resetPlayer(db, { playerId: item.player_id, reason: operation.reason, actorId, operationCode: item.reset_operation_code });
            } catch (error) {
                const details = { playerId: item.player_id, code: error?.code || 'child_exception', message: error?.message || String(error) };
                await markItem(db, operationId, item.player_id, { status: 'failed', last_error_json: JSON.stringify(details), finished_at: new Date().toISOString() });
                await refreshCounters(db, operationId);
                throw new GlobalPlayerResetError(`Falha no reset filho: ${item.player_id}.`, 'global_reset_child_exception', details);
            }
            if (!result?.ok) {
                const details = { playerId: item.player_id, code: result?.code || 'child_rejected', error: result?.error || null };
                await markItem(db, operationId, item.player_id, { status: 'failed', last_error_json: JSON.stringify(details), finished_at: new Date().toISOString() });
                await refreshCounters(db, operationId);
                throw new GlobalPlayerResetError(`Reset filho rejeitado: ${item.player_id}.`, 'global_reset_child_rejected', details);
            }
            await markItem(db, operationId, item.player_id, { status: 'applied', result_json: JSON.stringify({ code: result.code, playerId: result.playerId, result: result.result }), last_error_json: null, finished_at: new Date().toISOString() });
            await refreshCounters(db, operationId);
        }

        const counts = await refreshCounters(db, operationId);
        if (counts.failedCount || counts.appliedCount !== counts.expectedCount) throw new GlobalPlayerResetError('Contadores finais inconsistentes.', 'global_reset_counter_mismatch', counts);
        await db.run(`UPDATE ${OP_TABLE} SET status='completed',completed_at=CURRENT_TIMESTAMP,execution_token=NULL,last_error_json=NULL WHERE operation_id=? AND execution_token=?`, [operationId, token]);
        return { ok: true, operationId, status: 'completed', ...counts };
    } catch (error) {
        await db.run(`UPDATE ${OP_TABLE} SET status='paused',execution_token=NULL,last_error_json=? WHERE operation_id=? AND execution_token=?`, [JSON.stringify({ code: error?.code || 'global_reset_failed', message: error?.message || String(error), details: error?.details || null }), operationId, token]).catch(() => null);
        throw error;
    }
}

async function reconcileGlobalPlayerReset(db, { operationId, actorId } = {}) {
    assertOwner(actorId);
    const { operation, items } = await getGlobalPlayerResetOperation(db, operationId);
    const issues = [];
    for (const item of items) {
        if (item.status === 'skipped') continue;
        const event = await readResetEvent(db, item.reset_operation_code);
        if (!event) {
            if (['applied','reconciled'].includes(item.status)) issues.push({ code: 'event_missing', playerId: item.player_id });
            continue;
        }
        if (event.player_id !== item.player_id || event.status !== 'applied') {
            issues.push({ code: 'event_mismatch', playerId: item.player_id, eventPlayerId: event.player_id, eventStatus: event.status });
            continue;
        }
        if (!['applied','reconciled'].includes(item.status)) {
            await markItem(db, operationId, item.player_id, { status: 'reconciled', result_json: event.result_json || null, last_error_json: null, finished_at: new Date().toISOString() });
        }
    }
    const counts = await refreshCounters(db, operationId);
    const complete = !issues.length && !counts.failedCount && counts.appliedCount === counts.expectedCount;
    await db.run(`UPDATE ${OP_TABLE} SET status=?,reconciled_at=?,last_error_json=? WHERE operation_id=?`, [complete ? 'reconciled' : operation.status === 'completed' ? 'paused' : operation.status, complete ? new Date().toISOString() : null, issues.length ? JSON.stringify({ issues }) : null, operationId]);
    return { ok: complete, operationId, status: complete ? 'reconciled' : 'paused', issues, ...counts };
}

async function abortGlobalPlayerResetPlan(db, { operationId, actorId, reason } = {}) {
    assertOwner(actorId);
    const cleanReason = String(reason || '').trim();
    if (cleanReason.length < 8) throw new GlobalPlayerResetError('Motivo de abort obrigatório.', 'global_reset_abort_reason_required');
    await ensureGlobalPlayerResetSchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const operation = await db.get(`SELECT * FROM ${OP_TABLE} WHERE operation_id=?`, [operationId]);
        if (!operation) throw new GlobalPlayerResetError('Operação não encontrada.', 'global_reset_operation_not_found');
        if (operation.execution_token) throw new GlobalPlayerResetError('Executor ativo/órfão.', 'global_reset_execution_locked');
        const applied = await db.get(`SELECT COUNT(*) AS total FROM ${ITEM_TABLE} WHERE operation_id=? AND status IN ('applied','reconciled')`, [operationId]);
        if (Number(applied?.total || 0)) throw new GlobalPlayerResetError('Abort após mutação é proibido.', 'global_reset_abort_after_mutation_forbidden');
        const events = await db.get(`SELECT COUNT(*) AS total FROM clover_player_reset_events e JOIN ${ITEM_TABLE} i ON i.reset_operation_code=e.operation_code WHERE i.operation_id=?`, [operationId]);
        if (Number(events?.total || 0)) throw new GlobalPlayerResetError('Há eventos filhos; abort bloqueado.', 'global_reset_abort_event_exists');
        await db.run(`UPDATE ${OP_TABLE} SET status='aborted',aborted_at=CURRENT_TIMESTAMP,last_error_json=? WHERE operation_id=?`, [JSON.stringify({ reason: cleanReason, abortedBy: normalizeJid(actorId) || String(actorId) }), operationId]);
        await db.run(`DELETE FROM ${LOCK_TABLE} WHERE lock_key=? AND operation_id=?`, [LOCK_KEY, operationId]);
        await db.exec('COMMIT');
        return { ok: true, operationId, status: 'aborted' };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    FAILURE_POLICY,
    GlobalPlayerResetError,
    abortGlobalPlayerResetPlan,
    applyGlobalPlayerReset,
    childResetOperationCode,
    discoverTechnicalResetCandidates,
    ensureGlobalPlayerResetSchema,
    generateOperationId,
    getGlobalPlayerResetOperation,
    planGlobalPlayerReset,
    reconcileGlobalPlayerReset,
    snapshotHash,
};
