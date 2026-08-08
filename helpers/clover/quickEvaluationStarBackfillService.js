'use strict';

const { ensureSquadSeasonStarSchema } = require('./squadSeasonStarService');

const BACKFILL_SOURCE = 'ficha_avaliacao';
const BACKFILL_TRANSACTION_PREFIX = 'quick-evaluation:squad-stars:';

function safeInteger(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return 0;
    return Math.trunc(number);
}

function serializeMetadata(value) {
    return JSON.stringify(value && typeof value === 'object' ? value : {});
}

async function tableExists(db, name) {
    const row = await db.get(
        `SELECT 1 AS present FROM sqlite_master
         WHERE type = 'table' AND name = ? LIMIT 1`,
        [name]
    );
    return Boolean(row?.present);
}

async function requiredTablesExist(db) {
    const names = [
        'clover_quick_evaluations',
        'clover_squad_star_ledger',
        'clover_squad_seasons',
        'clover_squad_season_stars',
        'clover_squad_star_transactions',
        'clover_squads',
    ];
    const missing = [];
    for (const name of names) {
        if (!await tableExists(db, name)) missing.push(name);
    }
    return missing;
}

async function resolveSeasonReadOnly(db, sceneSentAt) {
    const text = String(sceneSentAt || '').trim();
    if (!text) return { error: 'missing_scene_sent_at' };
    const parsed = await db.get('SELECT datetime(?) AS parsed_at', [text]);
    if (!parsed?.parsed_at) return { error: 'invalid_scene_sent_at' };

    const matches = await db.all(
        `SELECT season_id
         FROM clover_squad_seasons
         WHERE status IN ('active', 'closed')
           AND (starts_at IS NULL OR datetime(starts_at) <= datetime(?))
           AND (ends_at IS NULL OR datetime(?) < datetime(ends_at))
         ORDER BY season_id`,
        [text, text]
    );
    if (!matches.length) return { error: 'season_not_found' };
    if (matches.length > 1) return { error: 'ambiguous_season', seasonIds: matches.map((row) => row.season_id) };
    return { seasonId: matches[0].season_id };
}

async function seasonTotalIsReconciled(db, squadKey, seasonId) {
    const row = await db.get(
        `SELECT
            COALESCE(s.season_stars, 0) AS season_stars,
            COALESCE((
                SELECT SUM(CASE WHEN t.kind = 'grant' AND t.amount > 0 THEN t.amount ELSE 0 END)
                FROM clover_squad_star_transactions t
                WHERE t.squad_key = ? AND t.season_id = ?
            ), 0) AS native_grants
         FROM clover_squad_season_stars s
         WHERE s.squad_key = ? AND s.season_id = ?`,
        [squadKey, seasonId, squadKey, seasonId]
    );
    if (!row) {
        return { reconciled: true, seasonStars: 0, nativeGrants: 0 };
    }
    const seasonStars = safeInteger(row.season_stars);
    const nativeGrants = safeInteger(row.native_grants);
    return {
        reconciled: seasonStars === nativeGrants,
        seasonStars,
        nativeGrants,
    };
}

async function planQuickEvaluationStarBackfill(db) {
    const missingTables = await requiredTablesExist(db);
    if (missingTables.length) {
        return {
            ok: false,
            schemaReady: false,
            missingTables,
            scanned: 0,
            candidates: [],
            invalid: [],
            alreadyNative: 0,
        };
    }

    const duplicateRows = await db.all(
        `SELECT evaluation_id, COUNT(*) AS total
         FROM clover_squad_star_ledger
         WHERE source = ? AND kind = 'ganho' AND evaluation_id IS NOT NULL AND amount > 0
         GROUP BY evaluation_id
         HAVING COUNT(*) > 1`,
        [BACKFILL_SOURCE]
    );
    const duplicateIds = new Set(duplicateRows.map((row) => Number(row.evaluation_id)));

    const rows = await db.all(
        `SELECT
            l.id AS legacy_ledger_id,
            l.squad_key,
            l.player_id,
            l.evaluation_id,
            l.amount,
            l.reason,
            l.created_by,
            l.created_at AS legacy_created_at,
            q.id AS quick_evaluation_id,
            q.stars_amount,
            q.scene_sent_at
         FROM clover_squad_star_ledger l
         LEFT JOIN clover_quick_evaluations q ON q.id = l.evaluation_id
         WHERE l.source = ?
           AND l.kind = 'ganho'
           AND l.evaluation_id IS NOT NULL
           AND l.amount > 0
         ORDER BY l.evaluation_id ASC, l.id ASC`,
        [BACKFILL_SOURCE]
    );

    const candidates = [];
    const invalid = [];
    let alreadyNative = 0;

    for (const row of rows) {
        const evaluationId = Number(row.evaluation_id);
        const transactionKey = `${BACKFILL_TRANSACTION_PREFIX}${evaluationId}`;
        if (duplicateIds.has(evaluationId)) {
            invalid.push({ evaluationId, code: 'duplicate_legacy_evaluation' });
            continue;
        }
        if (!row.quick_evaluation_id) {
            invalid.push({ evaluationId, code: 'quick_evaluation_missing' });
            continue;
        }
        const amount = safeInteger(row.amount);
        if (amount <= 0 || safeInteger(row.stars_amount) !== amount) {
            invalid.push({ evaluationId, code: 'star_amount_mismatch' });
            continue;
        }

        const seasonResolution = await resolveSeasonReadOnly(db, row.scene_sent_at);
        if (seasonResolution.error) {
            invalid.push({ evaluationId, code: seasonResolution.error });
            continue;
        }
        const seasonId = seasonResolution.seasonId;

        const existing = await db.get(
            `SELECT id, squad_key, season_id, player_id, amount, kind, source
             FROM clover_squad_star_transactions
             WHERE transaction_key = ?`,
            [transactionKey]
        );
        if (existing) {
            const sameIntent = existing.squad_key === row.squad_key
                && existing.season_id === seasonId
                && (existing.player_id || null) === (row.player_id || null)
                && safeInteger(existing.amount) === amount
                && existing.kind === 'grant'
                && existing.source === BACKFILL_SOURCE;
            if (!sameIntent) {
                invalid.push({ evaluationId, code: 'native_transaction_conflict' });
            } else {
                alreadyNative += 1;
            }
            continue;
        }

        const squad = await db.get(
            'SELECT squad_key FROM clover_squads WHERE squad_key = ?',
            [row.squad_key]
        );
        if (!squad) {
            invalid.push({ evaluationId, code: 'squad_missing' });
            continue;
        }

        const reconciliation = await seasonTotalIsReconciled(db, row.squad_key, seasonId);
        if (!reconciliation.reconciled) {
            invalid.push({
                evaluationId,
                code: 'season_total_unreconciled',
                seasonId,
                seasonStars: reconciliation.seasonStars,
                nativeGrants: reconciliation.nativeGrants,
            });
            continue;
        }

        candidates.push({
            evaluationId,
            legacyLedgerId: Number(row.legacy_ledger_id),
            squadKey: row.squad_key,
            playerId: row.player_id || null,
            amount,
            seasonId,
            sceneSentAt: row.scene_sent_at,
            reason: row.reason || 'Backfill nativo de Estrelas da avaliacao rapida.',
            createdBy: row.created_by || 'system',
            legacyCreatedAt: row.legacy_created_at || null,
            transactionKey,
        });
    }

    return {
        ok: invalid.length === 0,
        schemaReady: true,
        missingTables: [],
        scanned: rows.length,
        candidateCount: candidates.length,
        candidates,
        invalidCount: invalid.length,
        invalid,
        alreadyNative,
    };
}

function unsafePlanError(plan) {
    const error = new Error(
        `Backfill recusado: ${plan.invalidCount || 0} caso(s) nao reconciliados. ` +
        'Nenhuma alteracao foi aplicada.'
    );
    error.code = 'quick_evaluation_star_backfill_unsafe';
    error.invalid = plan.invalid || [];
    return error;
}

async function applyQuickEvaluationStarBackfill(db, options = {}) {
    if (options.apply !== true) {
        const preview = await planQuickEvaluationStarBackfill(db);
        return { ...preview, applied: false };
    }

    // Explicit apply may initialize a missing native schema; preview never does.
    await ensureSquadSeasonStarSchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const plan = await planQuickEvaluationStarBackfill(db);
        if (!plan.schemaReady || plan.invalidCount > 0) {
            throw unsafePlanError(plan);
        }

        for (const item of plan.candidates) {
            await db.run(
                `INSERT OR IGNORE INTO clover_squad_season_stars
                 (squad_key, season_id, season_stars)
                 VALUES (?, ?, 0)`,
                [item.squadKey, item.seasonId]
            );

            await db.run(
                `UPDATE clover_squad_season_stars
                 SET season_stars = season_stars + ?,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE squad_key = ? AND season_id = ?`,
                [item.amount, item.squadKey, item.seasonId]
            );

            await db.run(
                `INSERT INTO clover_squad_star_transactions
                 (transaction_key, squad_key, season_id, player_id, amount, kind, source,
                  reason, related_id, created_by, created_at, metadata_json)
                 VALUES (?, ?, ?, ?, ?, 'grant', ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)`,
                [
                    item.transactionKey,
                    item.squadKey,
                    item.seasonId,
                    item.playerId,
                    item.amount,
                    BACKFILL_SOURCE,
                    item.reason,
                    `quick_eval:${item.evaluationId}`,
                    item.createdBy,
                    item.legacyCreatedAt,
                    serializeMetadata({
                        historical_backfill: true,
                        evaluation_id: item.evaluationId,
                        legacy_ledger_id: item.legacyLedgerId,
                        scene_sent_at: item.sceneSentAt,
                        season_id: item.seasonId,
                    }),
                ]
            );
        }

        await db.exec('COMMIT');
        return {
            ...plan,
            applied: true,
            appliedCount: plan.candidateCount,
        };
    } catch (error) {
        try {
            await db.exec('ROLLBACK');
        } catch {}
        throw error;
    }
}

module.exports = {
    BACKFILL_SOURCE,
    BACKFILL_TRANSACTION_PREFIX,
    applyQuickEvaluationStarBackfill,
    planQuickEvaluationStarBackfill,
};
