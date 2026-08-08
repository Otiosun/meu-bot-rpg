'use strict';

const { RELIC_POOL, getBoxCatalog } = require('./seasonalEventCatalog');
const {
    effectiveRelicChance,
    getBoxPityPolicy,
    isQualitySuccessReward,
    qualityPityStatus,
} = require('./boxPityPolicy');

const PITY_MIGRATION_VERSION = 'history_v1';

function safeJson(value, fallback = null) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

async function ensureBoxPitySchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_box_pity_state (
            player_id TEXT NOT NULL,
            box_key TEXT NOT NULL,
            catalog_version INTEGER NOT NULL,
            quality_miss_streak INTEGER NOT NULL DEFAULT 0,
            relic_miss_streak INTEGER NOT NULL DEFAULT 0,
            last_reward_key TEXT DEFAULT NULL,
            last_opening_id INTEGER DEFAULT NULL,
            initialized_from TEXT NOT NULL DEFAULT 'history_v1',
            migration_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (player_id, box_key, catalog_version)
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_box_pity_player
        ON clover_box_pity_state (player_id, updated_at DESC)
    `);
}

async function relicPoolExhaustedAtOpening(db) {
    const row = await db.get(
        `SELECT COUNT(*) AS total, MAX(box_opening_id) AS final_opening_id
         FROM clover_seasonal_relic_ownership
         WHERE relic_key IN (${RELIC_POOL.map(() => '?').join(', ')})`,
        RELIC_POOL
    );
    return Number(row?.total || 0) >= RELIC_POOL.length
        ? Number(row?.final_opening_id || 0) || null
        : null;
}

function resolveBox(boxOrKey) {
    if (boxOrKey && typeof boxOrKey === 'object' && boxOrKey.key && Array.isArray(boxOrKey.rewards)) {
        return boxOrKey;
    }
    return getBoxCatalog(boxOrKey);
}

function normalizeStateRow(row, box) {
    const policy = getBoxPityPolicy(box);
    const qualityMissStreak = Math.max(0, Number(row?.quality_miss_streak || 0));
    const relicMissStreak = Math.max(0, Number(row?.relic_miss_streak || 0));
    return {
        playerId: row?.player_id || null,
        boxKey: box.key,
        catalogVersion: box.version,
        qualityMissStreak,
        relicMissStreak,
        lastRewardKey: row?.last_reward_key || null,
        lastOpeningId: row?.last_opening_id ? Number(row.last_opening_id) : null,
        initializedFrom: row?.initialized_from || PITY_MIGRATION_VERSION,
        migration: safeJson(row?.migration_json, null),
        policy,
        quality: qualityPityStatus(box, qualityMissStreak),
        relic: effectiveRelicChance(box, relicMissStreak),
    };
}

async function reconstructPityStateFromHistory(db, playerId, box) {
    const rows = await db.all(
        `SELECT id, reward_key, result_json, metadata_json, created_at
         FROM clover_box_openings
         WHERE player_id = ?
           AND box_key = ?
           AND catalog_version = ?
           AND status = 'completed'
         ORDER BY id ASC`,
        [playerId, box.key, box.version]
    );
    const rewardMap = new Map(box.rewards.map((reward) => [reward.key, reward]));
    const poolExhaustedAt = await relicPoolExhaustedAtOpening(db);
    let qualityMissStreak = 0;
    let relicMissStreak = 0;
    let lastRewardKey = null;
    let lastOpeningId = null;
    let ambiguousRows = 0;
    let reliableRows = 0;

    for (const row of rows) {
        const reward = rewardMap.get(row.reward_key) || null;
        const result = safeJson(row.result_json, {});
        const deliveredRelic = result?.type === 'relic';
        const relicFrozen = poolExhaustedAt && Number(row.id) > poolExhaustedAt;

        if (!reward && !deliveredRelic) {
            qualityMissStreak = 0;
            relicMissStreak = 0;
            ambiguousRows += 1;
        } else {
            reliableRows += 1;
            qualityMissStreak = (deliveredRelic || isQualitySuccessReward(reward))
                ? 0
                : qualityMissStreak + 1;
            if (!relicFrozen) {
                relicMissStreak = deliveredRelic ? 0 : relicMissStreak + 1;
            }
        }

        lastRewardKey = row.reward_key || null;
        lastOpeningId = Number(row.id);
    }

    const policy = getBoxPityPolicy(box);
    const historicalQualityMissStreak = qualityMissStreak;
    qualityMissStreak = Math.min(
        qualityMissStreak,
        Math.max(0, policy.quality.hardAtOpening - 1)
    );

    return {
        playerId,
        boxKey: box.key,
        catalogVersion: box.version,
        qualityMissStreak,
        relicMissStreak,
        lastRewardKey,
        lastOpeningId,
        initializedFrom: PITY_MIGRATION_VERSION,
        migration: {
            version: PITY_MIGRATION_VERSION,
            historicalRows: rows.length,
            reliableRows,
            ambiguousRows,
            historicalQualityMissStreak,
            importedQualityMissStreak: qualityMissStreak,
            importedRelicMissStreak: relicMissStreak,
            qualityCappedAtHardMinusOne: historicalQualityMissStreak !== qualityMissStreak,
            poolExhaustedAtOpening: poolExhaustedAt,
            retroactiveRewardGranted: false,
        },
    };
}

async function readStoredPityState(db, playerId, box) {
    await ensureBoxPitySchema(db);
    return db.get(
        `SELECT * FROM clover_box_pity_state
         WHERE player_id = ? AND box_key = ? AND catalog_version = ?`,
        [playerId, box.key, box.version]
    );
}

async function previewPlayerPityState(db, playerId, boxOrKey) {
    const box = resolveBox(boxOrKey);
    if (!box) throw new Error(`Caixa desconhecida: ${typeof boxOrKey === 'string' ? boxOrKey : boxOrKey?.key}`);
    const stored = await readStoredPityState(db, playerId, box);
    if (stored) return normalizeStateRow(stored, box);
    const state = await reconstructPityStateFromHistory(db, playerId, box);
    return normalizeStateRow({
        player_id: state.playerId || playerId,
        quality_miss_streak: state.qualityMissStreak,
        relic_miss_streak: state.relicMissStreak,
        last_reward_key: state.lastRewardKey,
        last_opening_id: state.lastOpeningId,
        initialized_from: state.initializedFrom,
        migration_json: state.migration ? JSON.stringify(state.migration) : null,
    }, box);
}

async function getOrCreatePityStateInTransaction(db, playerId, box) {
    const stored = await db.get(
        `SELECT * FROM clover_box_pity_state
         WHERE player_id = ? AND box_key = ? AND catalog_version = ?`,
        [playerId, box.key, box.version]
    );
    if (stored) return normalizeStateRow(stored, box);

    const reconstructed = await reconstructPityStateFromHistory(db, playerId, box);
    await db.run(
        `INSERT INTO clover_box_pity_state (
            player_id, box_key, catalog_version, quality_miss_streak,
            relic_miss_streak, last_reward_key, last_opening_id,
            initialized_from, migration_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
            playerId,
            box.key,
            box.version,
            reconstructed.qualityMissStreak,
            reconstructed.relicMissStreak,
            reconstructed.lastRewardKey,
            reconstructed.lastOpeningId,
            reconstructed.initializedFrom,
            JSON.stringify(reconstructed.migration),
        ]
    );
    return normalizeStateRow({
        player_id: playerId,
        quality_miss_streak: reconstructed.qualityMissStreak,
        relic_miss_streak: reconstructed.relicMissStreak,
        last_reward_key: reconstructed.lastRewardKey,
        last_opening_id: reconstructed.lastOpeningId,
        initialized_from: reconstructed.initializedFrom,
        migration_json: JSON.stringify(reconstructed.migration),
    }, box);
}

async function updatePityStateInTransaction(db, state, box, finalReward, openingId, options = {}) {
    const deliveredRelic = options.deliveredRelic === true;
    const relicCounterFrozen = options.relicCounterFrozen === true;
    const qualitySuccess = deliveredRelic || isQualitySuccessReward(finalReward);
    const qualityMissStreak = qualitySuccess ? 0 : state.qualityMissStreak + 1;
    const relicMissStreak = relicCounterFrozen
        ? state.relicMissStreak
        : (deliveredRelic ? 0 : state.relicMissStreak + 1);

    await db.run(
        `UPDATE clover_box_pity_state
         SET quality_miss_streak = ?,
             relic_miss_streak = ?,
             last_reward_key = ?,
             last_opening_id = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ? AND box_key = ? AND catalog_version = ?`,
        [
            qualityMissStreak,
            relicMissStreak,
            finalReward?.key || null,
            openingId,
            state.playerId,
            box.key,
            box.version,
        ]
    );

    return normalizeStateRow({
        player_id: state.playerId,
        quality_miss_streak: qualityMissStreak,
        relic_miss_streak: relicMissStreak,
        last_reward_key: finalReward?.key || null,
        last_opening_id: openingId,
        initialized_from: state.initializedFrom,
        migration_json: state.migration ? JSON.stringify(state.migration) : null,
    }, box);
}

function publicPityState(state) {
    if (!state) return null;
    return {
        boxKey: state.boxKey,
        catalogVersion: state.catalogVersion,
        qualityMissStreak: state.qualityMissStreak,
        relicMissStreak: state.relicMissStreak,
        lastRewardKey: state.lastRewardKey,
        lastOpeningId: state.lastOpeningId,
        quality: state.quality,
        relic: state.relic,
        initializedFrom: state.initializedFrom,
    };
}

module.exports = {
    PITY_MIGRATION_VERSION,
    ensureBoxPitySchema,
    getOrCreatePityStateInTransaction,
    normalizeStateRow,
    previewPlayerPityState,
    publicPityState,
    reconstructPityStateFromHistory,
    relicPoolExhaustedAtOpening,
    resolveBox,
    safeJson,
    updatePityStateInTransaction,
};
