'use strict';

const {
    ensureCloverRaidSchema,
    ensureCloverSquadSchema,
} = require('../../database');
const {
    CATEGORY_DEFINITIONS,
    raidMonthKey,
    resolveRaidCategory,
} = require('./raidCategoryCatalog');
const { ensureRaidMonthlyProgressSchema } = require('./raidMonthlyProgressService');

async function tableColumns(db, table) {
    const quoted = String(table).replace(/"/g, '""');
    return new Set((await db.all(`PRAGMA table_info("${quoted}")`)).map((column) => column.name));
}

async function ensureColumn(db, table, name, sql) {
    const columns = await tableColumns(db, table);
    if (columns.has(name)) return;
    await db.exec(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${sql}`);
}

async function ensureRaidV2Schema(db) {
    await ensureCloverRaidSchema(db);
    await ensureCloverSquadSchema(db);
    await ensureColumn(db, 'clover_raids', 'category_key', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_raids', 'category_label', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_raids', 'scope_type', "TEXT NOT NULL DEFAULT 'global'");
    await ensureColumn(db, 'clover_raids', 'scope_player_id', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_raids', 'scope_squad_key', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_raids', 'month_key', 'TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_raids', 'counts_monthly', 'INTEGER NOT NULL DEFAULT 0');
    await ensureColumn(db, 'clover_raids', 'monthly_limit', 'INTEGER DEFAULT NULL');
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_raids_monthly_scope
        ON clover_raids (
            category_key, month_key, scope_type,
            scope_player_id, scope_squad_key, status
        )
    `);

    const legacyRows = await db.all(
        `SELECT id, category, created_at
         FROM clover_raids
         WHERE category_key IS NULL OR TRIM(category_key) = ''`
    );
    for (const row of legacyRows) {
        let definition;
        try {
            definition = resolveRaidCategory(row.category);
        } catch {
            definition = CATEGORY_DEFINITIONS[0];
        }
        await db.run(
            `UPDATE clover_raids
             SET category_key = ?, category_label = ?, scope_type = 'global',
                 month_key = ?, counts_monthly = 0, monthly_limit = NULL
             WHERE id = ?`,
            [definition.key, definition.label, raidMonthKey(row.created_at), row.id]
        );
    }

    await db.run(
        `UPDATE clover_raids
         SET category_key = 'saga_pessoal', category_label = 'Saga individual'
         WHERE category_key = 'missao_desenvolvimento'`
    );

    await ensureRaidMonthlyProgressSchema(db);
}

module.exports = {
    ensureRaidV2Schema,
    tableColumns,
};