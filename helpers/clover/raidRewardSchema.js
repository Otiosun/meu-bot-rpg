'use strict';

const { ensureCloverRaidSchema } = require('../../database');
const { ensureCharacterStatAdjustmentSchema } = require('./characterStatAdjustmentService');
const { ensurePaSchema } = require('./paService');

async function tableColumns(db, table) {
    const quoted = String(table).replace(/"/g, '""');
    return new Set((await db.all(`PRAGMA table_info("${quoted}")`)).map((column) => column.name));
}

async function ensureColumn(db, table, name, sql) {
    const columns = await tableColumns(db, table);
    if (columns.has(name)) return;
    await db.exec(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${sql}`);
}

async function ensureRaidRewardV2Schema(db) {
    await ensureCloverRaidSchema(db);
    const row = await db.get(
        `SELECT sql FROM sqlite_master
         WHERE type = 'table' AND name = 'clover_raid_rewards'`
    );
    const sql = String(row?.sql || '');
    const supportsV2Types = ["'pa'", "'pm'", "'box'"]
        .every((token) => sql.includes(token));

    if (!supportsV2Types) {
        await db.exec('SAVEPOINT migrate_clover_raid_rewards_v2');
        try {
            await db.exec(`
                ALTER TABLE clover_raid_rewards
                RENAME TO clover_raid_rewards_legacy_v1;

                CREATE TABLE clover_raid_rewards (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    raid_id INTEGER NOT NULL,
                    target_type TEXT NOT NULL CHECK (target_type IN ('general', 'player')),
                    target_player_id TEXT DEFAULT NULL,
                    reward_type TEXT NOT NULL CHECK (
                        reward_type IN ('yulls', 'ph', 'stars', 'catalog_item', 'pa', 'pm', 'box')
                    ),
                    amount INTEGER NOT NULL DEFAULT 1 CHECK (
                        (reward_type = 'pm' AND amount != 0)
                        OR (reward_type != 'pm' AND amount > 0)
                    ),
                    template_key TEXT DEFAULT NULL,
                    resource_key TEXT DEFAULT NULL,
                    label TEXT NOT NULL,
                    reason TEXT DEFAULT NULL,
                    status TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'applied', 'cancelled')),
                    created_by TEXT NOT NULL,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    cancelled_at TEXT DEFAULT NULL,
                    cancelled_by TEXT DEFAULT NULL,
                    metadata_json TEXT DEFAULT NULL
                );

                INSERT INTO clover_raid_rewards (
                    id, raid_id, target_type, target_player_id, reward_type, amount,
                    template_key, resource_key, label, reason, status, created_by,
                    created_at, cancelled_at, cancelled_by, metadata_json
                )
                SELECT
                    id, raid_id, target_type, target_player_id, reward_type, amount,
                    template_key, NULL, label, reason, status, created_by,
                    created_at, cancelled_at, cancelled_by, metadata_json
                FROM clover_raid_rewards_legacy_v1;

                DROP TABLE clover_raid_rewards_legacy_v1;

                CREATE INDEX IF NOT EXISTS idx_clover_raid_rewards_raid
                ON clover_raid_rewards (raid_id, status, id);
            `);
            await db.exec('RELEASE SAVEPOINT migrate_clover_raid_rewards_v2');
        } catch (error) {
            await db.exec('ROLLBACK TO SAVEPOINT migrate_clover_raid_rewards_v2').catch(() => null);
            await db.exec('RELEASE SAVEPOINT migrate_clover_raid_rewards_v2').catch(() => null);
            throw error;
        }
    }

    await ensureColumn(db, 'clover_raid_rewards', 'resource_key', 'TEXT DEFAULT NULL');
}

async function ensureRaidFinalizationSchema(db) {
    await ensureCloverRaidSchema(db);
    await ensureColumn(
        db,
        'clover_raid_participants',
        'finalization_status',
        "TEXT NOT NULL DEFAULT 'pending'"
    );
    await ensureColumn(db, 'clover_raid_participants', 'finalization_note', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_raid_participants', 'finalized_by', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_raid_participants', 'finalized_at', 'TEXT DEFAULT NULL');
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_raid_participant_finalization
        ON clover_raid_participants (raid_id, finalization_status, status, id)
    `);
    await ensureRaidRewardV2Schema(db);
    await ensurePaSchema(db);
    await ensureCharacterStatAdjustmentSchema(db);
}

module.exports = {
    ensureColumn,
    ensureRaidFinalizationSchema,
    ensureRaidRewardV2Schema,
    tableColumns,
};
