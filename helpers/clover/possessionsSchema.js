'use strict';

const { ensureCloverInventorySchema } = require('../../database');

async function ensurePossessionsV1Schema(db) {
    await ensureCloverInventorySchema(db);

    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_player_titles_one_active
        ON clover_player_titles (player_id)
        WHERE active = 1
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_title_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title_id INTEGER DEFAULT NULL,
            player_id TEXT NOT NULL,
            title_key TEXT NOT NULL,
            title_name TEXT NOT NULL,
            action TEXT NOT NULL,
            actor_id TEXT DEFAULT NULL,
            source TEXT DEFAULT NULL,
            related_id TEXT DEFAULT NULL,
            before_active INTEGER DEFAULT NULL,
            after_active INTEGER DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            idempotency_key TEXT DEFAULT NULL UNIQUE,
            metadata_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_title_history_player
        ON clover_title_history (player_id, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_title_history_title
        ON clover_title_history (title_id, created_at DESC, id DESC)
    `);

    await db.run(`
        INSERT OR IGNORE INTO clover_title_history (
            title_id, player_id, title_key, title_name, action, actor_id,
            source, related_id, before_active, after_active, reason,
            idempotency_key, metadata_json, created_at
        )
        SELECT
            id, player_id, title_key, title_name, 'granted', NULL,
            source, related_id, 0, active, 'Registro anterior preservado',
            'title-grant-backfill:' || id,
            '{"backfill":true}',
            unlocked_at
        FROM clover_player_titles
    `);
}

module.exports = {
    ensurePossessionsV1Schema,
};
