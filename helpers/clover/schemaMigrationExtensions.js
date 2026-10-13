'use strict';

const { addColumnIfMissing } = require('./schemaMigrationService');

const SCENE_EVALUATION_INTEGRITY_VERSION = 31;
const SCENE_EVALUATION_INTEGRITY_KEY = '0031_scene_evaluation_integrity';

const QUICK_EVALUATION_STATUS_COLUMNS = Object.freeze([
    Object.freeze({ table: 'clover_quick_evaluations', column: 'status', definition: "TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','voided'))" }),
    Object.freeze({ table: 'clover_quick_evaluations', column: 'voided_at', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_quick_evaluations', column: 'voided_by', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_quick_evaluations', column: 'void_reason', definition: 'TEXT DEFAULT NULL' }),
    Object.freeze({ table: 'clover_quick_evaluations', column: 'correction_of', definition: 'INTEGER DEFAULT NULL' }),
]);

const EFFECTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS clover_quick_evaluation_effects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evaluation_id INTEGER NOT NULL,
    effect_type TEXT NOT NULL,
    effect_ref TEXT DEFAULT NULL,
    amount INTEGER DEFAULT NULL,
    status TEXT NOT NULL DEFAULT 'applied'
        CHECK (status IN ('pending','applied','reversed','skipped','failed')),
    idempotency_key TEXT NOT NULL UNIQUE,
    metadata_json TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reversed_at TEXT DEFAULT NULL,
    reversed_by TEXT DEFAULT NULL,
    FOREIGN KEY (evaluation_id) REFERENCES clover_quick_evaluations(id)
)`;

const EFFECT_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_clover_quick_eval_effects_eval
ON clover_quick_evaluation_effects (evaluation_id, status, id)`;

const EFFECT_TRIGGERS = Object.freeze([
    `CREATE TRIGGER IF NOT EXISTS trg_quick_eval_effect_player_stars
     AFTER INSERT ON clover_quick_evaluations
     WHEN NEW.stars_amount > 0
     BEGIN
       INSERT OR IGNORE INTO clover_quick_evaluation_effects
       (evaluation_id, effect_type, effect_ref, amount, status, idempotency_key, metadata_json)
       VALUES (NEW.id, 'player_stars', NEW.player_id, NEW.stars_amount, 'applied',
               'quick-eval:' || NEW.id || ':player-stars', '{}');
     END`,
    `CREATE TRIGGER IF NOT EXISTS trg_quick_eval_effect_ph
     AFTER INSERT ON clover_ph_ledger
     WHEN NEW.related_id LIKE 'quick_eval:%' AND NEW.amount > 0
     BEGIN
       INSERT OR IGNORE INTO clover_quick_evaluation_effects
       (evaluation_id, effect_type, effect_ref, amount, status, idempotency_key, metadata_json)
       VALUES (CAST(substr(NEW.related_id, 12) AS INTEGER), 'ph', CAST(NEW.id AS TEXT), NEW.amount, 'applied',
               'quick-eval:' || substr(NEW.related_id, 12) || ':ph:' || NEW.id, '{}');
     END`,
    `CREATE TRIGGER IF NOT EXISTS trg_quick_eval_effect_yulls
     AFTER INSERT ON clover_yulls_ledger
     WHEN NEW.related_id LIKE 'quick_eval:%' AND NEW.amount > 0
     BEGIN
       INSERT OR IGNORE INTO clover_quick_evaluation_effects
       (evaluation_id, effect_type, effect_ref, amount, status, idempotency_key, metadata_json)
       VALUES (CAST(substr(NEW.related_id, 12) AS INTEGER), 'yulls', CAST(NEW.id AS TEXT), NEW.amount, 'applied',
               'quick-eval:' || substr(NEW.related_id, 12) || ':yulls:' || NEW.id, '{}');
     END`,
    `CREATE TRIGGER IF NOT EXISTS trg_quick_eval_effect_inventory_insert
     AFTER INSERT ON clover_inventory_items
     WHEN NEW.related_id LIKE 'quick_eval:%'
     BEGIN
       INSERT OR IGNORE INTO clover_quick_evaluation_effects
       (evaluation_id, effect_type, effect_ref, amount, status, idempotency_key, metadata_json)
       VALUES (CAST(substr(NEW.related_id, 12) AS INTEGER), 'inventory_item', CAST(NEW.id AS TEXT), NEW.quantity, 'applied',
               'quick-eval:' || substr(NEW.related_id, 12) || ':inventory:' || NEW.id, '{}');
     END`,
    `CREATE TRIGGER IF NOT EXISTS trg_quick_eval_effect_squad_stars
     AFTER INSERT ON clover_squad_star_transactions
     WHEN NEW.related_id LIKE 'quick_eval:%' AND NEW.amount > 0
     BEGIN
       INSERT OR IGNORE INTO clover_quick_evaluation_effects
       (evaluation_id, effect_type, effect_ref, amount, status, idempotency_key, metadata_json)
       VALUES (CAST(substr(NEW.related_id, 12) AS INTEGER), 'squad_stars', CAST(NEW.id AS TEXT), NEW.amount, 'applied',
               'quick-eval:' || substr(NEW.related_id, 12) || ':squad-stars:' || NEW.id, '{}');
     END`,
]);

const SCENE_EVALUATION_INTEGRITY_MIGRATION = Object.freeze({
    version: SCENE_EVALUATION_INTEGRITY_VERSION,
    key: SCENE_EVALUATION_INTEGRITY_KEY,
    description: 'Adiciona estado aplicado/anulado e manifesto auditavel de efeitos das avaliacoes de cena.',
    checksumMaterial: Object.freeze({
        columns: QUICK_EVALUATION_STATUS_COLUMNS,
        effectsTable: EFFECTS_TABLE_SQL.replace(/\s+/g, ' ').trim(),
        effectsIndex: EFFECT_INDEX_SQL.replace(/\s+/g, ' ').trim(),
        triggers: EFFECT_TRIGGERS.map((sql) => sql.replace(/\s+/g, ' ').trim()),
        revision: 'scene-evaluation-integrity-v1',
    }),
    async up(db) {
        for (const target of QUICK_EVALUATION_STATUS_COLUMNS) {
            await addColumnIfMissing(db, target);
        }
        await db.exec(EFFECTS_TABLE_SQL);
        await db.exec(EFFECT_INDEX_SQL);
        for (const sql of EFFECT_TRIGGERS) await db.exec(sql);
    },
});

const SCHEMA_MIGRATION_EXTENSIONS = Object.freeze([
    SCENE_EVALUATION_INTEGRITY_MIGRATION,
]);

module.exports = {
    SCENE_EVALUATION_INTEGRITY_KEY,
    SCENE_EVALUATION_INTEGRITY_MIGRATION,
    SCENE_EVALUATION_INTEGRITY_VERSION,
    SCHEMA_MIGRATION_EXTENSIONS,
};
