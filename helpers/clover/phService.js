const { assertResetPlayerCanPlay } = require('./resetDeferredStateService');
const { assertLifecycleAllowed, lifecycleSkip, isPreResetLifecycle } = require('./lifecyclePolicy');
const crypto = require('crypto');
const {
    ensureCloverCharacterStatsSchema,
    ensureCloverPhLedgerSchema,
} = require('../../database');
const {
    ensureCharacterStats,
    getNextStageByPh,
    getPbUsage,
    getStageByPh,
    getStageConfig,
    getStageName,
} = require('./characterStats');

class PhServiceError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'PhServiceError';
        this.code = code;
    }
}

const INITIAL_PH_AMOUNT = 15;
const INITIAL_PH_SOURCE = 'initial_ph';
const INITIAL_PH_RELATED_ID = 'initial_ph_v1';

function asIntegerAmount(value, options = {}) {
    const number = Number(value);
    if (!Number.isInteger(number) || Number.isNaN(number) || number === 0) {
        throw new PhServiceError('invalid_amount', 'Quantidade de PH inválida.');
    }

    if (!options.allowNegative && number < 0) {
        throw new PhServiceError('invalid_amount', 'Quantidade de PH precisa ser positiva.');
    }

    return number;
}

function safeJsonParse(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function normalizeReason(reason) {
    return String(reason || '').trim();
}

function serializeMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') return null;
    return JSON.stringify(metadata);
}

const phSchemaPromises = new WeakMap();

async function ensurePhSchema(db) {
    if (!db || typeof db !== 'object') {
        throw new PhServiceError('database_unavailable', 'Banco indisponivel.');
    }
    let initialization = phSchemaPromises.get(db);
    if (!initialization) {
        initialization = Promise.resolve().then(async () => {
            await ensureCloverCharacterStatsSchema(db);
            await ensureCloverPhLedgerSchema(db);
            await db.run(
                `CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_ph_initial_once
                 ON clover_ph_ledger(player_id, source, related_id)
                 WHERE source = '${INITIAL_PH_SOURCE}' AND related_id = '${INITIAL_PH_RELATED_ID}'`
            );
        }).catch((error) => {
            phSchemaPromises.delete(db);
            throw error;
        });
        phSchemaPromises.set(db, initialization);
    }
    return initialization;
}

async function ensurePhState(db, playerId) {
    await assertResetPlayerCanPlay(db,playerId);
    if (isPreResetLifecycle()) {
        const existing = await db.get('SELECT * FROM clover_character_stats WHERE player_id=?',[playerId]);
        const initial = existing && await db.get("SELECT id FROM clover_ph_ledger WHERE player_id=? AND source='initial_ph' AND related_id='initial_ph_v1'",[playerId]);
        if (initial && existing.ph_available != null && existing.ph_accumulated != null) return existing;
        assertLifecycleAllowed({surface:'internal',operation:'ph.initial_grant',mutationClass:'CURRENT_WORLD'});
    }

    if (!playerId) {
        throw new PhServiceError('missing_player', 'Player inválido.');
    }

    await ensurePhSchema(db);
    const stats = await ensureCharacterStats(db, playerId);

    if (stats.ph_accumulated === null || stats.ph_available === null) {
        await db.run(
            `UPDATE clover_character_stats
             SET ph_accumulated = COALESCE(ph_accumulated, 0),
                 ph_available = COALESCE(ph_available, 0),
                 updated_at = CURRENT_TIMESTAMP
             WHERE player_id = ?`,
            [playerId]
        );
    }

    const insertedInitial = await ensureInitialPhLedger(db, playerId);
    if (insertedInitial) {
        return applyPhStateFromLedger(db, playerId);
    }

    return db.get('SELECT * FROM clover_character_stats WHERE player_id = ?', [playerId]);
}

function getLedgerDeltas(entry) {
    const amount = Number(entry.amount || 0);
    const metadata = safeJsonParse(entry.metadata_json, {});

    if (entry.kind === 'ganho') {
        const gain = Math.abs(amount);
        return { accumulated: gain, available: gain };
    }

    if (entry.kind === 'gasto' || entry.kind === 'perda') {
        return { accumulated: 0, available: -Math.abs(amount) };
    }

    if (entry.kind === 'ajuste_admin') {
        const affectsAccumulated = metadata.affects_accumulated === true || amount > 0;
        return {
            accumulated: affectsAccumulated ? amount : 0,
            available: amount,
        };
    }

    if (entry.kind === 'estorno') {
        const accumulated = Number.isInteger(metadata.accumulated_delta)
            ? metadata.accumulated_delta
            : 0;
        const available = Number.isInteger(metadata.available_delta)
            ? metadata.available_delta
            : amount;
        return { accumulated, available };
    }

    return { accumulated: 0, available: 0 };
}

function calculatePhStateFromLedger(rows) {
    let accumulated = 0;
    let available = 0;

    for (const row of rows || []) {
        const delta = getLedgerDeltas(row);
        accumulated += delta.accumulated;
        available += delta.available;
    }

    return {
        accumulated: Math.max(0, accumulated),
        available: Math.max(0, available),
    };
}

async function readLedgerRows(db, playerId) {
    return db.all(
        `SELECT *
         FROM clover_ph_ledger
         WHERE player_id = ?
         ORDER BY id ASC`,
        [playerId]
    );
}

// This snapshot intentionally does not repair the stats projection. Consumers
// that need policy provenance can read the PH ledger without mutating gameplay.
async function getPhLedgerAuthoritySnapshot(db, playerId) {
    if (!playerId) throw new PhServiceError('missing_player', 'Player invÃ¡lido.');
    const rows = await readLedgerRows(db, playerId);
    const state = calculatePhStateFromLedger(rows);
    const digestRows = rows.map((row) => ({
        id: row.id,
        amount: row.amount,
        kind: row.kind,
        source: row.source,
        related_id: row.related_id,
        metadata_json: row.metadata_json,
        created_at: row.created_at,
    }));
    return {
        playerId,
        available: state.available,
        accumulated: state.accumulated,
        ledgerDigest: crypto.createHash('sha256').update(JSON.stringify(digestRows), 'utf8').digest('hex'),
        entryCount: rows.length,
    };
}

function resolveStageForStats(stats, phAccumulated) {
    if (String(stats?.stage_key) === 'arcano') {
        return getStageConfig('arcano');
    }
    return getStageByPh(phAccumulated);
}

async function applyPhStateFromLedger(db, playerId) {
    const stats = await db.get('SELECT * FROM clover_character_stats WHERE player_id = ?', [playerId]);
    if (!stats) {
        throw new PhServiceError('missing_stats', 'Stats do personagem não existem.');
    }

    const rows = await readLedgerRows(db, playerId);
    const state = calculatePhStateFromLedger(rows);
    const stage = resolveStageForStats(stats, state.accumulated);

    await db.run(
        `UPDATE clover_character_stats
         SET ph_accumulated = ?,
             ph_available = ?,
             stage_key = ?,
             pb_total = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ?`,
        [state.accumulated, state.available, stage.key, stage.pb, playerId]
    );

    return db.get('SELECT * FROM clover_character_stats WHERE player_id = ?', [playerId]);
}

function buildSummary(stats) {
    const phAccumulated = Number(stats?.ph_accumulated || 0);
    const phAvailable = Number(stats?.ph_available || 0);
    const stageKey = String(stats?.stage_key || '9');
    const nextStage = getNextStageByPh(phAccumulated, stageKey);
    const pb = getPbUsage(stats);

    return {
        playerId: stats.player_id,
        phAccumulated,
        phAvailable,
        stageKey,
        stageName: getStageName(stageKey),
        pbTotal: pb.pbTotal,
        pbSpent: pb.used,
        pbFree: pb.free,
        nextStageKey: nextStage?.key || null,
        nextStageName: nextStage?.name || null,
        missingForNext: nextStage ? Math.max(0, Number(nextStage.ph_required || 0) - phAccumulated) : null,
    };
}

async function recalculatePh(db, playerId) {
    await ensurePhState(db, playerId);
    const stats = await applyPhStateFromLedger(db, playerId);
    return buildSummary(stats);
}

async function getPhSummary(db, playerId) {
    return recalculatePh(db, playerId);
}

async function getPhHistory(db, playerId, limit = 10) {
    await ensurePhState(db, playerId);
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
    return db.all(
        `SELECT *
         FROM clover_ph_ledger
         WHERE player_id = ?
         ORDER BY id DESC
         LIMIT ?`,
        [playerId, safeLimit]
    );
}

async function insertLedgerEntry(db, entry) {
    const result = await db.run(
        `INSERT INTO clover_ph_ledger
         (player_id, amount, kind, source, reason, related_id, created_by, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
            entry.playerId,
            entry.amount,
            entry.kind,
            entry.source || null,
            entry.reason || null,
            entry.relatedId || null,
            entry.createdBy || null,
            serializeMetadata(entry.metadata),
        ]
    );

    return result.lastID;
}

async function findStableLedgerEntry(db, entry) {
    if (!entry.source || !entry.relatedId) return null;
    return db.get(
        `SELECT * FROM clover_ph_ledger
         WHERE player_id = ? AND source = ? AND related_id = ?
         ORDER BY id ASC
         LIMIT 1`,
        [entry.playerId, entry.source, entry.relatedId]
    );
}

function assertStableLedgerEntryMatches(existing, entry) {
    if (!existing) return;
    if (Number(existing.amount) !== Number(entry.amount) || existing.kind !== entry.kind) {
        throw new PhServiceError(
            'ph_idempotency_conflict',
            'A chave estável de PH já foi usada com outro lançamento.'
        );
    }
}

async function replayStableLedgerEntry(db, playerId, existing) {
    const stats = await applyPhStateFromLedger(db, playerId);
    const summary = buildSummary(stats);
    return {
        ok: true,
        replayed: true,
        ledgerId: existing.id,
        kind: existing.kind,
        amount: Number(existing.amount),
        before: summary,
        after: summary,
        stageChanged: false,
        pbChanged: false,
    };
}

// Transaction-scoped only: callers own the enclosing atomic business operation.
// The ledger remains immutable; this appends one entry and refreshes its summary
// projection from that history without attempting a reverse reconciliation.
async function appendPhLedgerEntryWithLifecycleInTransaction(db, playerId, entry, lifecycle) {
    assertLifecycleAllowed({
        surface: 'internal',
        operation: lifecycle.operation,
        mutationClass: lifecycle.mutationClass,
    });
    await assertResetPlayerCanPlay(db, playerId);
    const beforeStats = await applyPhStateFromLedger(db, playerId);
    const before = buildSummary(beforeStats);
    const normalizedEntry = { ...entry, playerId };
    const existing = await findStableLedgerEntry(db, normalizedEntry);
    assertStableLedgerEntryMatches(existing, normalizedEntry);
    if (existing) return replayStableLedgerEntry(db, playerId, existing);
    const ledgerId = await insertLedgerEntry(db, normalizedEntry);
    const nextStats = await applyPhStateFromLedger(db, playerId);
    const after = buildSummary(nextStats);
    return {
        ok: true,
        replayed: false,
        ledgerId,
        kind: entry.kind,
        amount: entry.amount,
        before,
        after,
        stageChanged: before.stageKey !== after.stageKey,
        pbChanged: before.pbTotal !== after.pbTotal,
    };
}

async function appendPhLedgerEntryInTransaction(db, playerId, entry) {
    return appendPhLedgerEntryWithLifecycleInTransaction(db, playerId, entry, {
        operation: 'ph.ledger.append',
        mutationClass: 'CURRENT_WORLD',
    });
}

async function ensureInitialPhLedger(db, playerId) {
    await assertResetPlayerCanPlay(db,playerId);
    const result = await db.run(
        `INSERT OR IGNORE INTO clover_ph_ledger
         (player_id, amount, kind, source, reason, related_id, created_by, created_at, metadata_json)
         VALUES (?, ?, 'ganho', ?, ?, ?, 'system', CURRENT_TIMESTAMP, ?)`,
        [
            playerId,
            INITIAL_PH_AMOUNT,
            INITIAL_PH_SOURCE,
            'PH inicial do personagem',
            INITIAL_PH_RELATED_ID,
            serializeMetadata({ initial_ph: true, version: 1 }),
        ]
    );

    return Number(result?.changes || 0) > 0;
}

async function runLedgerMutation(db, playerId, entry, beforeSummary) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        const normalizedEntry = { ...entry, playerId };
        const existing = await findStableLedgerEntry(db, normalizedEntry);
        assertStableLedgerEntryMatches(existing, normalizedEntry);
        if (existing) {
            const replay = await replayStableLedgerEntry(db, playerId, existing);
            await db.exec('COMMIT');
            return replay;
        }
        const ledgerId = await insertLedgerEntry(db, normalizedEntry);
        const nextStats = await applyPhStateFromLedger(db, playerId);
        await db.exec('COMMIT');

        const afterSummary = buildSummary(nextStats);
        return {
            ok: true,
            replayed: false,
            ledgerId,
            kind: entry.kind,
            amount: entry.amount,
            before: beforeSummary,
            after: afterSummary,
            stageChanged: beforeSummary.stageKey !== afterSummary.stageKey,
            pbChanged: beforeSummary.pbTotal !== afterSummary.pbTotal,
        };
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

async function mutatePh(db, playerId, entry) {
    assertLifecycleAllowed({
        surface: 'internal',
        operation: 'ph.mutate',
        mutationClass: 'CURRENT_WORLD',
    });
    await assertResetPlayerCanPlay(db,playerId);
    await ensurePhState(db, playerId);
    const before = await getPhSummary(db, playerId);

    if (entry.amount < 0 && before.phAvailable < Math.abs(entry.amount)) {
        throw new PhServiceError('insufficient_ph', 'PH disponível insuficiente.');
    }

    return runLedgerMutation(db, playerId, entry, before);
}

async function addPh(db, playerId, amount, source, reason, createdBy, metadata = {}, relatedId = null) {
    const value = asIntegerAmount(amount);
    return mutatePh(db, playerId, {
        amount: Math.abs(value),
        kind: 'ganho',
        source,
        reason: normalizeReason(reason),
        relatedId,
        createdBy,
        metadata,
    });
}

async function spendPh(db, playerId, amount, source, reason, createdBy, metadata = {}) {
    const value = asIntegerAmount(amount);
    return mutatePh(db, playerId, {
        amount: -Math.abs(value),
        kind: 'gasto',
        source,
        reason: normalizeReason(reason),
        createdBy,
        metadata,
    });
}

async function spendPhInTransaction(db, playerId, amount, source, reason, createdBy, metadata = {}, relatedId = null) {
    assertLifecycleAllowed({
        surface: 'internal',
        operation: 'ph.spend',
        mutationClass: 'CURRENT_WORLD',
    });
    await assertResetPlayerCanPlay(db,playerId);
    const value = asIntegerAmount(amount);
    const beforeStats = await applyPhStateFromLedger(db, playerId);
    const before = buildSummary(beforeStats);

    if (before.phAvailable < Math.abs(value)) {
        throw new PhServiceError('insufficient_ph', 'PH disponível insuficiente.');
    }

    const entry = {
        playerId,
        amount: -Math.abs(value),
        kind: 'gasto',
        source,
        reason: normalizeReason(reason),
        relatedId,
        createdBy,
        metadata,
    };
    const ledgerId = await insertLedgerEntry(db, entry);
    const nextStats = await applyPhStateFromLedger(db, playerId);
    const after = buildSummary(nextStats);

    return {
        ok: true,
        ledgerId,
        kind: entry.kind,
        amount: entry.amount,
        before,
        after,
        stageChanged: before.stageKey !== after.stageKey,
        pbChanged: before.pbTotal !== after.pbTotal,
    };
}

async function addPhInTransaction(db, playerId, amount, source, reason, createdBy, metadata = {}, relatedId = null) {
    const value = asIntegerAmount(amount);
    const entry = {
        playerId,
        amount: Math.abs(value),
        kind: 'ganho',
        source,
        reason: normalizeReason(reason),
        relatedId,
        createdBy,
        metadata,
    };
    return appendPhLedgerEntryWithLifecycleInTransaction(db, playerId, entry, {
        operation: 'ph.grant',
        mutationClass: 'CURRENT_WORLD',
    });
}

async function addPreResetPhInTransaction(db, playerId, amount, source, reason, createdBy, metadata = {}, relatedId = null) {
    const existingStats = await db.get(
        'SELECT id FROM clover_character_stats WHERE player_id = ?',
        [playerId]
    );
    if (!existingStats) {
        assertLifecycleAllowed({
            surface: 'internal',
            operation: 'ph.prereset.initialize_projection',
            mutationClass: 'PRE_RESET',
        });
        const stage = getStageConfig();
        await db.run(
            `INSERT INTO clover_character_stats
             (player_id, stage_key, pb_total, pb_spent, distribution_status, created_at, updated_at)
             VALUES (?, ?, ?, 0, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [playerId, stage.key, stage.pb]
        );
    }
    const value = asIntegerAmount(amount);
    const entry = {
        playerId,
        amount: Math.abs(value),
        kind: 'ganho',
        source,
        reason: normalizeReason(reason),
        relatedId,
        createdBy,
        metadata,
    };
    return appendPhLedgerEntryWithLifecycleInTransaction(db, playerId, entry, {
        operation: 'ph.prereset.grant',
        mutationClass: 'PRE_RESET',
    });
}

async function removeAvailablePh(db, playerId, amount, source, reason, createdBy, metadata = {}) {
    assertLifecycleAllowed({surface:'internal',operation:'removeAvailablePh',mutationClass:'CURRENT_WORLD'});
    const value = asIntegerAmount(amount);
    return mutatePh(db, playerId, {
        amount: -Math.abs(value),
        kind: 'perda',
        source,
        reason: normalizeReason(reason),
        createdBy,
        metadata,
    });
}

async function adminAdjustPh(db, playerId, amount, reason, createdBy, options = {}) {
    assertLifecycleAllowed({surface:'internal',operation:'adminAdjustPh',mutationClass:'CURRENT_WORLD'});
    await assertResetPlayerCanPlay(db,playerId);
    const value = asIntegerAmount(amount, { allowNegative: true });
    const before = await getPhSummary(db, playerId);
    const affectsAccumulated = value > 0 || options.affectAccumulated === true;

    if (value < 0 && before.phAvailable < Math.abs(value)) {
        throw new PhServiceError('insufficient_ph', 'PH disponível insuficiente.');
    }
    if (value < 0 && affectsAccumulated && before.phAccumulated < Math.abs(value)) {
        throw new PhServiceError('insufficient_accumulated_ph', 'PH acumulado insuficiente.');
    }

    await ensurePhState(db, playerId);
    return runLedgerMutation(db, playerId, {
        amount: value,
        kind: 'ajuste_admin',
        source: options.source || 'comando_admin',
        reason: normalizeReason(reason),
        relatedId: options.relatedId || null,
        createdBy,
        metadata: {
            ...(options.metadata || {}),
            affects_accumulated: affectsAccumulated,
        },
    }, before);
}

module.exports = {
    INITIAL_PH_AMOUNT,
    INITIAL_PH_RELATED_ID,
    INITIAL_PH_SOURCE,
    PhServiceError,
    addPh,
    addPhInTransaction,
    addPreResetPhInTransaction,
    appendPhLedgerEntryInTransaction,
    adminAdjustPh,
    ensurePhState,
    getPhHistory,
    getPhLedgerAuthoritySnapshot,
    getPhSummary,
    recalculatePh,
    removeAvailablePh,
    spendPh,
    spendPhInTransaction,
};
