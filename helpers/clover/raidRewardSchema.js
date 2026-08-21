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
}

async function ensureRaidFinalizationSchema(db) {
    await ensureCloverRaidSchema(db);
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
