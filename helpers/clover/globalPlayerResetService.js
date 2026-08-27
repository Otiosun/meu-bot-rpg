'use strict';

const crypto = require('crypto');
const { isOwner, normalizeJid } = require('../groupAccess');
const {
    captureResetSnapshot,
    ensurePlayerResetSchema,
    previewResetPlayer,
    resetPlayer,
    signaturesEqual,
} = require('./playerResetService');
const { inspectChildResetEventBinding } = require('./globalPlayerResetEventBinding');
const { sha256, snapshotHash } = require('./resetSnapshotIntegrity');

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

function childResetOperationCode(operationId, playerId) {
    return `RS-G-${sha256(`${operationId}|${playerId}`).slice(0, 20).toUpperCase()}`;
}

function normalizePlayerIds(values) {
    return [...new Set((values || [])
        .map((value) => normalizeJid(value) || String(value || '').trim())
        .filter(Boolean))]
        .sort();
}

function summarizeJournalItems(items) {
    return {
        selectedCount: items.length,
        expectedCount: items.filter((item) => item.status !== 'skipped').length,
        skippedCount: items.filter((item) => item.status === 'skipped').length,
    };
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
        `SELECT id, operation_code, player_id, scope, status, before_json, after_json, result_json
         FROM clover_player_reset_events WHERE operation_code = ?`,
        [resetOperationCode]
    );
}

function assertBoundChildEvent(item, event, phase) {
    const binding = inspectChildResetEventBinding(item, event);
    if (!binding.ok) {
        throw new GlobalPlayerResetError(
            'Evento filho não está criptograficamente vinculado ao dry-run congelado.',
            'global_reset_child_event_binding_mismatch',
            { phase, playerId: item.player_id, binding }
        );
    }
    return binding;
}

function parseSnapshotJson(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

async function inspectPersistedChildPostState(db, item, event) {
    const expectedAfter = parseSnapshotJson(event?.after_json);
    const current = await captureResetSnapshot(db, item?.player_id);
    const expectedPresent = Boolean(expectedAfter?.player);
    const currentPresent = Boolean(current?.player);
    const matches = expectedPresent && currentPresent && signaturesEqual(current, expectedAfter);
    return {
        ok: matches,
        playerId: item?.player_id || null,
        resetOperationCode: item?.reset_operation_code || null,
        expectedPresent,
        currentPresent,
    };
}

async function assertPersistedChildPostState(db, item, event, phase) {
    const postState = await inspectPersistedChildPostState(db, item, event);
    if (!postState.ok) {
        throw new GlobalPlayerResetError(
            'Estado persistido do player divergiu do pós-reset certificado pelo child event.',
            'global_reset_child_post_state_drift',
            { phase, ...postState }
        );
    }
    return postState;
}

function populationHash(items) {
    return sha256(JSON.stringify(items.map((item) => ({
        playerId: item.playerId,
        ordinal: Number(item.ordinal || 0),
        status: item.status,
        snapshotSha256: item.snapshotSha256,
        resetOperationCode: item.resetOperationCode,
    }))));
}

function journalPopulationHash(items) {
    return populationHash(items.map((item) => ({
        playerId: item.player_id ?? item.playerId,
        ordinal: Number(item.ordinal || 0),
        status: item.status === 'skipped' ? 'skipped' : 'pending',
        snapshotSha256: item.planned_snapshot_sha256 ?? item.snapshotSha256,
        resetOperationCode: item.reset_operation_code ?? item.resetOperationCode,
    })));
}

function inspectFrozenJournalIntegrity(operation, items) {
    const observedCounters = summarizeJournalItems(items);
    const frozenCounters = {
        selectedCount: Number(operation?.selected_count || 0),
        expectedCount: Number(operation?.expected_count || 0),
        skippedCount: Number(operation?.skipped_count || 0),
    };
    const countersMatch = observedCounters.selectedCount === frozenCounters.selectedCount
        && observedCounters.expectedCount === frozenCounters.expectedCount
        && observedCounters.skippedCount === frozenCounters.skippedCount;
    const observedPopulationHash = journalPopulationHash(items);
    const frozenPopulationHash = String(operation?.population_hash || '');
    const populationHashMatch = observedPopulationHash === frozenPopulationHash;
    return {
        ok: countersMatch && populationHashMatch && observedCounters.expectedCount > 0,
        countersMatch,
        populationHashMatch,
        emptyEffectivePopulation: observedCounters.expectedCount === 0,
        frozenCounters,
        observedCounters,
        frozenPopulationHash,
        observedPopulationHash,
    };
}

function assertFrozenJournalIntegrity(operation, items) {
    const integrity = inspectFrozenJournalIntegrity(operation, items);
    if (!integrity.countersMatch) {
        throw new GlobalPlayerResetError(
            'Contadores congelados divergiram do journal.',
            'global_reset_frozen_counter_drift',
            { frozen: integrity.frozenCounters, observed: integrity.observedCounters }
        );
    }
    if (integrity.emptyEffectivePopulation) {
        throw new GlobalPlayerResetError(
            'Operação global não possui população efetiva.',
            'global_reset_empty_effective_population',
            integrity.observedCounters
        );
    }
    if (!integrity.populationHashMatch) {
        throw new GlobalPlayerResetError(
            'Journal congelado divergiu do population hash.',
            'global_reset_population_journal_drift',
            { frozen: integrity.frozenPopulationHash, observed: integrity.observedPopulationHash }
        );
    }
    return integrity;
}

async function inspectGlobalResetCycleLock(db, operationId) {
    const lock = await db.get(`SELECT * FROM ${LOCK_TABLE} WHERE lock_key=?`, [LOCK_KEY]);
    if (!lock) {
        return { ok: false, code: 'global_reset_cycle_lock_missing', operationId, lock: null };
    }
    if (lock.operation_id !== operationId) {
        return {
            ok: false,
            code: 'global_reset_cycle_lock_mismatch',
            operationId,
            lockOperationId: lock.operation_id,
            lock,
        };
    }
    return { ok: true, operationId, lock };
}

async function assertGlobalResetCycleLock(db, operationId) {
    const lockState = await inspectGlobalResetCycleLock(db, operationId);
    if (!lockState.ok) {
        throw new GlobalPlayerResetError(
            lockState.code === 'global_reset_cycle_lock_missing'
                ? 'Lock canônico do ciclo global está ausente.'
                : `Lock canônico pertence a outra operação: ${lockState.lockOperationId}.`,
            lockState.code,
            lockState
        );
    }
    return lockState.lock;
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
        `UPDATE ${OP_TABLE}
         SET applied_count=?, failed_count=?, reconciled_count=?
         WHERE operation_id=?`,
        [counts.appliedCount, counts.failedCount, counts.reconciledCount, operationId]
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
        const { expectedCount, skippedCount } = summarizeJournalItems(items);
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
        await assertGlobalResetCycleLock(db, operationId);
        const items = await db.all(`SELECT * FROM ${ITEM_TABLE} WHERE operation_id=? ORDER BY ordinal`, [operationId]);
        assertFrozenJournalIntegrity(op, items);
        await db.run(`UPDATE ${OP_TABLE} SET status='running',execution_token=?,started_at=COALESCE(started_at,CURRENT_TIMESTAMP),last_error_json=NULL WHERE operation_id=?`, [token, operationId]);
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }

    try {
        const { operation, items } = await getGlobalPlayerResetOperation(db, operationId);
        await assertGlobalResetCycleLock(db, operationId);
        assertFrozenJournalIntegrity(operation, items);

        for (const item of items) {
            if (item.status === 'skipped') continue;
            const existingEvent = await readResetEvent(db, item.reset_operation_code);
            if (existingEvent) {
                assertBoundChildEvent(item, existingEvent, 'cohort_preflight_existing_event');
                await assertPersistedChildPostState(db, item, existingEvent, 'cohort_preflight_existing_event');
                continue;
            }
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
                assertBoundChildEvent(item, event, 'resume_existing_event');
                await assertPersistedChildPostState(db, item, event, 'resume_existing_event');
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
                result = await resetPlayer(db, {
                    playerId: item.player_id,
                    reason: operation.reason,
                    actorId,
                    operationCode: item.reset_operation_code,
                    expectedBeforeSnapshotSha256: item.planned_snapshot_sha256,
                });
            } catch (error) {
                const details = { playerId: item.player_id, code: error?.code || 'child_exception', message: error?.message || String(error) };
                await markItem(db, operationId, item.player_id, { status: 'failed', last_error_json: JSON.stringify(details), finished_at: new Date().toISOString() });
                await refreshCounters(db, operationId);
                throw new GlobalPlayerResetError(`Falha no reset filho: ${item.player_id}.`, 'global_reset_child_exception', details);
            }
            if (!result?.ok) {
                const details = { playerId: item.player_id, code: result?.code || 'child_rejected', error: result?.error || null, details: result?.details || null };
                await markItem(db, operationId, item.player_id, { status: 'failed', last_error_json: JSON.stringify(details), finished_at: new Date().toISOString() });
                await refreshCounters(db, operationId);
                throw new GlobalPlayerResetError(`Reset filho rejeitado: ${item.player_id}.`, 'global_reset_child_rejected', details);
            }

            const committedEvent = await readResetEvent(db, item.reset_operation_code);
            if (!committedEvent) {
                throw new GlobalPlayerResetError(
                    `Reset filho retornou sucesso sem evento persistido: ${item.player_id}.`,
                    'global_reset_child_event_missing_after_commit',
                    { playerId: item.player_id, phase: 'post_child_commit' }
                );
            }
            assertBoundChildEvent(item, committedEvent, 'post_child_commit');
            await assertPersistedChildPostState(db, item, committedEvent, 'post_child_commit');
            await markItem(db, operationId, item.player_id, { status: 'applied', result_json: committedEvent.result_json || null, last_error_json: null, finished_at: new Date().toISOString() });
            await refreshCounters(db, operationId);
        }

        let counts;
        await db.exec('BEGIN IMMEDIATE');
        try {
            const finalOperation = await db.get(`SELECT * FROM ${OP_TABLE} WHERE operation_id=?`, [operationId]);
            if (!finalOperation || finalOperation.status !== 'running' || finalOperation.execution_token !== token) {
                throw new GlobalPlayerResetError(
                    'Executor/status mudou antes da certificação final.',
                    'global_reset_completion_compare_and_swap_failed',
                    {
                        operationId,
                        expectedExecutionToken: token,
                        actualExecutionToken: finalOperation?.execution_token || null,
                        actualStatus: finalOperation?.status || null,
                    }
                );
            }
            await assertGlobalResetCycleLock(db, operationId);
            const finalItems = await db.all(`SELECT * FROM ${ITEM_TABLE} WHERE operation_id=? ORDER BY ordinal`, [operationId]);
            assertFrozenJournalIntegrity(finalOperation, finalItems);
            for (const item of finalItems) {
                if (item.status === 'skipped') continue;
                const event = await readResetEvent(db, item.reset_operation_code);
                if (!event) {
                    throw new GlobalPlayerResetError(
                        `Child event ausente na certificação final: ${item.player_id}.`,
                        'global_reset_child_event_missing_at_completion',
                        { playerId: item.player_id, phase: 'final_completion_certification' }
                    );
                }
                assertBoundChildEvent(item, event, 'final_completion_certification');
                await assertPersistedChildPostState(db, item, event, 'final_completion_certification');
            }
            counts = await refreshCounters(db, operationId);
            if (counts.failedCount || counts.appliedCount !== counts.expectedCount) {
                throw new GlobalPlayerResetError('Contadores finais inconsistentes.', 'global_reset_counter_mismatch', counts);
            }
            const completed = await db.run(
                `UPDATE ${OP_TABLE}
                 SET status='completed',completed_at=CURRENT_TIMESTAMP,execution_token=NULL,last_error_json=NULL
                 WHERE operation_id=? AND execution_token=? AND status='running'`,
                [operationId, token]
            );
            if (Number(completed?.changes || 0) !== 1) {
                throw new GlobalPlayerResetError(
                    'CAS final de conclusão não afetou exatamente uma operação.',
                    'global_reset_completion_compare_and_swap_failed',
                    { operationId, expectedExecutionToken: token, changes: Number(completed?.changes || 0) }
                );
            }
            await db.exec('COMMIT');
        } catch (error) {
            await db.exec('ROLLBACK').catch(() => null);
            throw error;
        }
        return { ok: true, operationId, status: 'completed', ...counts };
    } catch (error) {
        await db.run(`UPDATE ${OP_TABLE} SET status='paused',execution_token=NULL,last_error_json=? WHERE operation_id=? AND execution_token=?`, [JSON.stringify({ code: error?.code || 'global_reset_failed', message: error?.message || String(error), details: error?.details || null }), operationId, token]).catch(() => null);
        throw error;
    }
}

async function reconcileGlobalPlayerReset(db, { operationId, actorId } = {}) {
    assertOwner(actorId);
    await ensureGlobalPlayerResetSchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const operation = await db.get(`SELECT * FROM ${OP_TABLE} WHERE operation_id=?`, [operationId]);
        if (!operation) throw new GlobalPlayerResetError('Operação global não encontrada.', 'global_reset_operation_not_found');
        if (operation.execution_token) throw new GlobalPlayerResetError('Executor ativo/órfão; reconcile recusado.', 'global_reset_execution_locked');
        if (!['paused','completed','reconciled'].includes(operation.status)) {
            throw new GlobalPlayerResetError(`Status inválido para reconcile: ${operation.status}.`, 'global_reset_reconcile_invalid_status');
        }
        await assertGlobalResetCycleLock(db, operationId);
        const items = await db.all(`SELECT * FROM ${ITEM_TABLE} WHERE operation_id=? ORDER BY ordinal`, [operationId]);
        assertFrozenJournalIntegrity(operation, items);

        const issues = [];
        for (const item of items) {
            if (item.status === 'skipped') continue;
            const event = await readResetEvent(db, item.reset_operation_code);
            if (!event) {
                if (['applied','reconciled'].includes(item.status)) issues.push({ code: 'event_missing', playerId: item.player_id });
                else if (item.status === 'failed') issues.push({ code: 'failed_without_event', playerId: item.player_id });
                else if (item.status === 'processing') issues.push({ code: 'processing_without_event', playerId: item.player_id });
                continue;
            }
            const binding = inspectChildResetEventBinding(item, event);
            if (!binding.ok) {
                issues.push({ code: 'event_binding_mismatch', playerId: item.player_id, binding });
                continue;
            }
            if (operation.status === 'paused') {
                const postState = await inspectPersistedChildPostState(db, item, event);
                if (!postState.ok) {
                    issues.push({ code: 'post_state_drift', playerId: item.player_id, postState });
                    continue;
                }
            }
            if (!['applied','reconciled'].includes(item.status)) {
                await markItem(db, operationId, item.player_id, { status: 'reconciled', result_json: event.result_json || null, last_error_json: null, finished_at: new Date().toISOString() });
            }
        }
        const counts = await refreshCounters(db, operationId);
        const complete = !issues.length && !counts.failedCount && counts.appliedCount === counts.expectedCount;
        const nextStatus = complete ? 'reconciled' : 'paused';
        const evidence = complete ? null : JSON.stringify({
            code: 'global_reset_reconcile_incomplete',
            issues,
            counts,
            previousLastError: operation.last_error_json || null,
        });
        await db.run(
            `UPDATE ${OP_TABLE}
             SET status=?,reconciled_at=?,last_error_json=? WHERE operation_id=?`,
            [nextStatus, complete ? new Date().toISOString() : null, evidence, operationId]
        );
        await db.exec('COMMIT');
        return { ok: complete, operationId, status: nextStatus, issues, ...counts };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
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
        if (!['planned','paused'].includes(operation.status)) throw new GlobalPlayerResetError(`Status inválido para abort: ${operation.status}.`, 'global_reset_abort_invalid_status');
        await assertGlobalResetCycleLock(db, operationId);
        const items = await db.all(`SELECT * FROM ${ITEM_TABLE} WHERE operation_id=? ORDER BY ordinal`, [operationId]);
        assertFrozenJournalIntegrity(operation, items);
        const applied = await db.get(`SELECT COUNT(*) AS total FROM ${ITEM_TABLE} WHERE operation_id=? AND status IN ('applied','reconciled')`, [operationId]);
        if (Number(applied?.total || 0)) throw new GlobalPlayerResetError('Abort após mutação é proibido.', 'global_reset_abort_after_mutation_forbidden');
        const events = await db.get(`SELECT COUNT(*) AS total FROM clover_player_reset_events e JOIN ${ITEM_TABLE} i ON i.reset_operation_code=e.operation_code WHERE i.operation_id=?`, [operationId]);
        if (Number(events?.total || 0)) throw new GlobalPlayerResetError('Há eventos filhos; abort bloqueado.', 'global_reset_abort_event_exists');
        await db.run(`UPDATE ${OP_TABLE} SET status='aborted',aborted_at=CURRENT_TIMESTAMP,last_error_json=? WHERE operation_id=?`, [JSON.stringify({ reason: cleanReason, abortedBy: normalizeJid(actorId) || String(actorId) }), operationId]);
        const released = await db.run(`DELETE FROM ${LOCK_TABLE} WHERE lock_key=? AND operation_id=?`, [LOCK_KEY, operationId]);
        if (Number(released?.changes || 0) !== 1) throw new GlobalPlayerResetError('Lock canônico não foi liberado exatamente uma vez.', 'global_reset_cycle_lock_release_failed');
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
    inspectFrozenJournalIntegrity,
    inspectGlobalResetCycleLock,
    inspectPersistedChildPostState,
    planGlobalPlayerReset,
    reconcileGlobalPlayerReset,
    snapshotHash,
};
