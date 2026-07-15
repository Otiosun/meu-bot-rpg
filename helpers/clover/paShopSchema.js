'use strict';

async function ensureCloverPaShopSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_pa_shop_purchases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            evaluator_id TEXT NOT NULL,
            player_id TEXT NOT NULL,
            item_key TEXT NOT NULL,
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            unit_pa_cost INTEGER NOT NULL CHECK (unit_pa_cost >= 0),
            pa_cost INTEGER NOT NULL CHECK (pa_cost >= 0),
            reward_json TEXT NOT NULL DEFAULT '{}',
            week_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'completed'
                CHECK (status IN ('completed', 'refunded', 'void')),
            source TEXT NOT NULL DEFAULT 'pa_shop',
            idempotency_key TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            voided_at TEXT DEFAULT NULL,
            voided_by TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_pa_shop_idempotency
        ON clover_pa_shop_purchases (idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_pa_shop_evaluator_week
        ON clover_pa_shop_purchases (evaluator_id, week_key, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_pa_shop_limit
        ON clover_pa_shop_purchases (evaluator_id, week_key, item_key, status)
    `);
}

module.exports = {
    ensureCloverPaShopSchema,
};