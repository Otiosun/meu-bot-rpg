'use strict';

const {
    ensureCloverAdminServiceSchema,
    ensureCloverCharacterStatsSchema,
    ensureCloverPhLedgerSchema,
    ensureCloverQuickEvaluationsSchema,
    ensureCloverRecruitmentSchema,
} = require('../../database');
const { DEFAULT_EVENT_KEY, getMondayWeekKey, mutatePrInTransaction } = require('./prService');

const DEFAULT_CONVERSION_KEY = 'reset_pr_v1';
const CONVERSION_SOURCE = 'conversao_pr';
const CONVERSION_REASON = 'Conversao final de PH e PA para PR antes do reset';

class PrResetConversionError extends Error {
    constructor(code, message, details = {}) {
        super(message || code);
        this.name = 'PrResetConversionError';
        this.code = code;
        this.details = details;
    }
}

function asKey(value) {
    return String(value || DEFAULT_CONVERSION_KEY)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9:_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || DEFAULT_CONVERSION_KEY;
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

async function ensurePrResetConversionSchema(db) {
    await ensureCloverRecruitmentSchema(db);
    await ensureCloverCharacterStatsSchema(db);
    await ensureCloverPhLedgerSchema(db);
    await ensureCloverQuickEvaluationsSchema(db);
    await ensureCloverAdminServiceSchema(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_pr_reset_conversion_runs (
            conversion_key TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'applied',
            player_count INTEGER NOT NULL DEFAULT 0,
            total_ph INTEGER NOT NULL DEFAULT 0,
            total_pa INTEGER NOT NULL DEFAULT 0,
            total_pr INTEGER NOT NULL DEFAULT 0,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_pr_reset_conversion_players (
            conversion_key TEXT NOT NULL,
            player_id TEXT NOT NULL,
            character_name TEXT DEFAULT NULL,
            ph_converted INTEGER NOT NULL DEFAULT 0,
            ph_available_before INTEGER NOT NULL DEFAULT 0,
            pa_converted INTEGER NOT NULL DEFAULT 0,
            pr_granted INTEGER NOT NULL DEFAULT 0,
            pr_ledger_id INTEGER DEFAULT NULL,
            ph_ledger_id INTEGER DEFAULT NULL,
            payout_id INTEGER DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (conversion_key, player_id)
        )
    `);
    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_ph_pr_conversion_once
        ON clover_ph_ledger (player_id, source, related_id)
        WHERE source = '${CONVERSION_SOURCE}'
    `);
}

async function readAppliedRun(db, conversionKey) {
    const row = await db.get(
        'SELECT * FROM clover_pr_reset_conversion_runs WHERE conversion_key = ?',
        [conversionKey]
    );
    if (!row) return null;
    return {
        conversionKey: row.conversion_key,
        status: row.status,
        duplicate: true,
        totals: {
            players: Number(row.player_count || 0),
            ph: Number(row.total_ph || 0),
            pa: Number(row.total_pa || 0),
            pr: Number(row.total_pr || 0),
        },
        metadata: parseJson(row.metadata_json, {}),
        createdBy: row.created_by || null,
        createdAt: row.created_at || null,
    };
}

async function readTableColumns(db, tableName) {
    const rows = await db.all(`PRAGMA table_info(${tableName})`);
    return new Set(rows.map((row) => row.name));
}

function optionalColumnPredicate(columns, alias, column, sql) {
    return columns.has(column) ? sql : '1 = 1';
}

async function eligiblePlayerWhere(db, alias = 'j') {
    const columns = await readTableColumns(db, 'jogadores');
    return [
        `LOWER(COALESCE(${alias}.jogo_status, '')) = 'liberado'`,
        optionalColumnPredicate(columns, alias, 'is_shadow', `COALESCE(${alias}.is_shadow, 0) = 0`),
        optionalColumnPredicate(columns, alias, 'is_test_user', `COALESCE(${alias}.is_test_user, 0) = 0`),
        optionalColumnPredicate(columns, alias, 'character_kind', `LOWER(COALESCE(${alias}.character_kind, 'player')) = 'player'`),
        optionalColumnPredicate(columns, alias, 'merged_into', `COALESCE(${alias}.merged_into, '') = ''`),
        optionalColumnPredicate(columns, alias, 'identity_status', `LOWER(COALESCE(${alias}.identity_status, 'active')) = 'active'`),
        optionalColumnPredicate(columns, alias, 'lifecycle_status', `LOWER(COALESCE(${alias}.lifecycle_status, 'active')) = 'active'`),
    ].join(' AND ');
}

async function readPhRows(db) {
    const where = await eligiblePlayerWhere(db, 'j');
    return db.all(
        `SELECT
             j.id AS player_id,
             COALESCE(j.personagem_nome, j.nome, j.display_name, j.id) AS character_name,
             MAX(0, COALESCE(s.ph_accumulated, 0)) AS ph_accumulated,
             MAX(0, COALESCE(s.ph_available, 0)) AS ph_available
         FROM jogadores j
         JOIN clover_character_stats s ON s.player_id = j.id
         WHERE ${where}
           AND (COALESCE(s.ph_accumulated, 0) > 0 OR COALESCE(s.ph_available, 0) > 0)
         ORDER BY j.id ASC`
    );
}

async function readPendingPaRows(db) {
    const where = await eligiblePlayerWhere(db, 'j');
    return db.all(
        `SELECT
             j.id AS player_id,
             COALESCE(j.personagem_nome, j.nome, j.display_name, j.id) AS character_name,
             COALESCE(SUM(s.points - s.paid_points), 0) AS pending_pa,
             COUNT(*) AS pending_entries
         FROM clover_admin_service_entries s
         JOIN jogadores j ON j.id = s.evaluator_id
         WHERE ${where}
           AND s.status IN ('pending', 'partial')
           AND s.points > s.paid_points
         GROUP BY j.id
         HAVING pending_pa > 0
         ORDER BY j.id ASC`
    );
}

async function buildConversionPlan(db, conversionKey) {
    const [phRows, paRows] = await Promise.all([readPhRows(db), readPendingPaRows(db)]);
    const byPlayer = new Map();
    for (const row of phRows) {
        byPlayer.set(row.player_id, {
            playerId: row.player_id,
            characterName: row.character_name || row.player_id,
            ph: Number(row.ph_accumulated || 0),
            phAvailable: Number(row.ph_available || 0),
            pa: 0,
            pendingEntries: 0,
        });
    }
    for (const row of paRows) {
        const current = byPlayer.get(row.player_id) || {
            playerId: row.player_id,
            characterName: row.character_name || row.player_id,
            ph: 0,
            phAvailable: 0,
            pa: 0,
            pendingEntries: 0,
        };
        current.pa = Number(row.pending_pa || 0);
        current.pendingEntries = Number(row.pending_entries || 0);
        byPlayer.set(row.player_id, current);
    }

    const players = [...byPlayer.values()]
        .map((row) => ({
            ...row,
            pr: Number(row.ph || 0) + Number(row.pa || 0),
            idempotencyKey: `pr-reset-conversion:${conversionKey}:${row.playerId}`,
        }))
        .filter((row) => row.pr > 0)
        .sort((left, right) => left.playerId.localeCompare(right.playerId));

    return {
        conversionKey,
        players,
        totals: players.reduce((totals, row) => ({
            players: totals.players + 1,
            ph: totals.ph + row.ph,
            pa: totals.pa + row.pa,
            pr: totals.pr + row.pr,
        }), { players: 0, ph: 0, pa: 0, pr: 0 }),
    };
}

async function previewPrResetConversion(db, options = {}) {
    const conversionKey = asKey(options.conversionKey);
    await ensurePrResetConversionSchema(db);
    const applied = await readAppliedRun(db, conversionKey);
    if (applied) return applied;
    return buildConversionPlan(db, conversionKey);
}

async function consumePendingPa(db, playerId) {
    const entries = await db.all(
        `SELECT id, points, paid_points
         FROM clover_admin_service_entries
         WHERE evaluator_id = ?
           AND status IN ('pending', 'partial')
           AND points > paid_points
         ORDER BY created_at ASC, id ASC`,
        [playerId]
    );
    const consumed = [];
    for (const entry of entries) {
        const amount = Number(entry.points || 0) - Number(entry.paid_points || 0);
        if (amount <= 0) continue;
        await db.run(
            `UPDATE clover_admin_service_entries
             SET paid_points = points,
                 status = 'paid'
             WHERE id = ?`,
            [entry.id]
        );
        consumed.push({ entryId: entry.id, points: amount });
    }
    return consumed;
}

async function zeroConvertedPh(db, row, conversionKey, createdBy) {
    if (row.ph <= 0 && row.phAvailable <= 0) return null;
    const relatedId = `pr-reset-conversion:${conversionKey}:${row.playerId}:ph`;
    const existing = await db.get(
        `SELECT id FROM clover_ph_ledger
         WHERE player_id = ? AND source = ? AND related_id = ?`,
        [row.playerId, CONVERSION_SOURCE, relatedId]
    );
    if (existing) return Number(existing.id);

    const inserted = await db.run(
        `INSERT INTO clover_ph_ledger
         (player_id, amount, kind, source, reason, related_id, created_by, created_at, metadata_json)
         VALUES (?, ?, 'estorno', ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
            row.playerId,
            -Math.max(1, Number(row.phAvailable || row.ph || 1)),
            CONVERSION_SOURCE,
            CONVERSION_REASON,
            relatedId,
            createdBy || 'system',
            JSON.stringify({
                conversion_key: conversionKey,
                converted_to_pr: row.ph,
                accumulated_delta: -row.ph,
                available_delta: -row.phAvailable,
                ph_available_before: row.phAvailable,
            }),
        ]
    );
    await db.run(
        `UPDATE clover_character_stats
         SET ph_accumulated = 0,
             ph_available = 0,
             updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ?`,
        [row.playerId]
    );
    return Number(inserted.lastID || 0);
}

async function insertPaPayout(db, row, conversionKey, createdBy, consumed) {
    if (row.pa <= 0) return null;
    const weekKey = getMondayWeekKey(new Date());
    const inserted = await db.run(
        `INSERT INTO clover_admin_service_payouts
         (evaluator_id, player_id, points_paid, ph_paid, week_key, source, reason, created_by, ledger_id, metadata_json)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, NULL, ?)`,
        [
            row.playerId,
            row.playerId,
            row.pa,
            weekKey,
            CONVERSION_SOURCE,
            CONVERSION_REASON,
            createdBy || 'system',
            JSON.stringify({ conversion_key: conversionKey, conversion_week_key: weekKey, consumed_entries: consumed }),
        ]
    );
    return Number(inserted.lastID || 0);
}

async function applyPrResetConversion(db, options = {}) {
    const conversionKey = asKey(options.conversionKey);
    const createdBy = options.createdBy || 'system';
    await ensurePrResetConversionSchema(db);

    const applied = await readAppliedRun(db, conversionKey);
    if (applied) return applied;

    await db.exec('BEGIN IMMEDIATE');
    try {
        const plan = await buildConversionPlan(db, conversionKey);
        const appliedPlayers = [];
        for (const row of plan.players) {
            const consumed = await consumePendingPa(db, row.playerId);
            const payoutId = await insertPaPayout(db, row, conversionKey, createdBy, consumed);
            const prResult = await mutatePrInTransaction(db, row.playerId, {
                amount: row.pr,
                kind: 'ajuste_admin',
                source: 'ajuste_admin',
                reason: CONVERSION_REASON,
                eventKey: DEFAULT_EVENT_KEY,
                relatedId: `pr-reset-conversion:${conversionKey}:${row.playerId}`,
                idempotencyKey: row.idempotencyKey,
                createdBy,
                metadata: {
                    conversion_key: conversionKey,
                    conversion_source: CONVERSION_SOURCE,
                    ph_converted: row.ph,
                    pa_converted: row.pa,
                    pending_entries: row.pendingEntries,
                },
            });
            const phLedgerId = await zeroConvertedPh(db, row, conversionKey, createdBy);
            await db.run(
                `INSERT INTO clover_pr_reset_conversion_players
                 (conversion_key, player_id, character_name, ph_converted, ph_available_before,
                  pa_converted, pr_granted, pr_ledger_id, ph_ledger_id, payout_id, metadata_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    conversionKey,
                    row.playerId,
                    row.characterName,
                    row.ph,
                    row.phAvailable,
                    row.pa,
                    row.pr,
                    prResult.ledgerId,
                    phLedgerId,
                    payoutId,
                    JSON.stringify({ consumed_entries: consumed }),
                ]
            );
            appliedPlayers.push({
                ...row,
                prLedgerId: prResult.ledgerId,
                phLedgerId,
                payoutId,
                consumedEntries: consumed,
            });
        }
        const totals = appliedPlayers.reduce((total, row) => ({
            players: total.players + 1,
            ph: total.ph + row.ph,
            pa: total.pa + row.pa,
            pr: total.pr + row.pr,
        }), { players: 0, ph: 0, pa: 0, pr: 0 });
        await db.run(
            `INSERT INTO clover_pr_reset_conversion_runs
             (conversion_key, status, player_count, total_ph, total_pa, total_pr, created_by, metadata_json)
             VALUES (?, 'applied', ?, ?, ?, ?, ?, ?)`,
            [
                conversionKey,
                totals.players,
                totals.ph,
                totals.pa,
                totals.pr,
                createdBy,
                JSON.stringify({ reason: CONVERSION_REASON }),
            ]
        );
        await db.exec('COMMIT');
        return { conversionKey, players: appliedPlayers, totals };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

module.exports = {
    CONVERSION_REASON,
    CONVERSION_SOURCE,
    DEFAULT_CONVERSION_KEY,
    PrResetConversionError,
    applyPrResetConversion,
    ensurePrResetConversionSchema,
    previewPrResetConversion,
};
