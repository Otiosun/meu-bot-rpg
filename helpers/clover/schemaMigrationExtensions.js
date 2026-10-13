'use strict';

const {
    addColumnIfMissing,
    tableExists,
} = require('./schemaMigrationService');

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

const CORRECTIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS clover_quick_evaluation_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evaluation_id INTEGER NOT NULL,
    correction_type TEXT NOT NULL CHECK (correction_type IN ('void')),
    reason TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    before_json TEXT NOT NULL DEFAULT '{}',
    after_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (evaluation_id) REFERENCES clover_quick_evaluations(id)
)`;

const CORRECTION_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_clover_quick_eval_corrections_eval
ON clover_quick_evaluation_corrections (evaluation_id, created_at, id)`;

const CORRECTION_IMMUTABILITY_TRIGGERS = Object.freeze([
    `CREATE TRIGGER IF NOT EXISTS trg_quick_eval_correction_immutable_update
     BEFORE UPDATE ON clover_quick_evaluation_corrections
     BEGIN
       SELECT RAISE(ABORT, 'quick_evaluation_correction_immutable');
     END`,
    `CREATE TRIGGER IF NOT EXISTS trg_quick_eval_correction_immutable_delete
     BEFORE DELETE ON clover_quick_evaluation_corrections
     BEGIN
       SELECT RAISE(ABORT, 'quick_evaluation_correction_immutable');
     END`,
]);

const EFFECT_TRIGGER_SPECS = Object.freeze([
    Object.freeze({
        table: 'clover_quick_evaluations',
        sql: `CREATE TRIGGER IF NOT EXISTS trg_quick_eval_effect_player_stars
             AFTER INSERT ON clover_quick_evaluations
             WHEN NEW.stars_amount > 0
             BEGIN
               INSERT OR IGNORE INTO clover_quick_evaluation_effects
               (evaluation_id, effect_type, effect_ref, amount, status, idempotency_key, metadata_json)
               VALUES (NEW.id, 'player_stars', NEW.player_id, NEW.stars_amount, 'applied',
                       'quick-eval:' || NEW.id || ':player-stars', '{}');
             END`,
    }),
    Object.freeze({
        table: 'clover_ph_ledger',
        sql: `CREATE TRIGGER IF NOT EXISTS trg_quick_eval_effect_ph
             AFTER INSERT ON clover_ph_ledger
             WHEN NEW.related_id LIKE 'quick_eval:%' AND NEW.amount > 0
             BEGIN
               INSERT OR IGNORE INTO clover_quick_evaluation_effects
               (evaluation_id, effect_type, effect_ref, amount, status, idempotency_key, metadata_json)
               VALUES (CAST(substr(NEW.related_id, 12) AS INTEGER), 'ph', CAST(NEW.id AS TEXT), NEW.amount, 'applied',
                       'quick-eval:' || substr(NEW.related_id, 12) || ':ph:' || NEW.id, '{}');
             END`,
    }),
    Object.freeze({
        table: 'clover_ph_ledger',
        sql: `CREATE TRIGGER IF NOT EXISTS trg_quick_eval_effect_return_bonus_ph
             AFTER INSERT ON clover_ph_ledger
             WHEN NEW.source = 'return_bonus'
               AND NEW.amount > 0
               AND json_extract(COALESCE(NEW.metadata_json, '{}'), '$.evaluation_id') IS NOT NULL
             BEGIN
               INSERT OR IGNORE INTO clover_quick_evaluation_effects
               (evaluation_id, effect_type, effect_ref, amount, status, idempotency_key, metadata_json)
               VALUES (
                   CAST(json_extract(NEW.metadata_json, '$.evaluation_id') AS INTEGER),
                   'return_bonus_ph',
                   CAST(NEW.id AS TEXT),
                   NEW.amount,
                   'applied',
                   'quick-eval:' || json_extract(NEW.metadata_json, '$.evaluation_id') || ':return-bonus-ph:' || NEW.id,
                   json_object('bonus_id', json_extract(NEW.metadata_json, '$.bonus_id'))
               );
             END`,
    }),
    Object.freeze({
        table: 'clover_yulls_ledger',
        sql: `CREATE TRIGGER IF NOT EXISTS trg_quick_eval_effect_yulls
             AFTER INSERT ON clover_yulls_ledger
             WHEN NEW.related_id LIKE 'quick_eval:%' AND NEW.amount > 0
             BEGIN
               INSERT OR IGNORE INTO clover_quick_evaluation_effects
               (evaluation_id, effect_type, effect_ref, amount, status, idempotency_key, metadata_json)
               VALUES (CAST(substr(NEW.related_id, 12) AS INTEGER), 'yulls', CAST(NEW.id AS TEXT), NEW.amount, 'applied',
                       'quick-eval:' || substr(NEW.related_id, 12) || ':yulls:' || NEW.id, '{}');
             END`,
    }),
    Object.freeze({
        table: 'clover_inventory_item_history',
        sql: `CREATE TRIGGER IF NOT EXISTS trg_quick_eval_effect_inventory_history
             AFTER INSERT ON clover_inventory_item_history
             WHEN NEW.related_id LIKE 'quick_eval:%' AND NEW.quantity_delta > 0
             BEGIN
               INSERT OR IGNORE INTO clover_quick_evaluation_effects
               (evaluation_id, effect_type, effect_ref, amount, status, idempotency_key, metadata_json)
               VALUES (
                   CAST(substr(NEW.related_id, 12) AS INTEGER),
                   'inventory_history',
                   CAST(NEW.id AS TEXT),
                   NEW.quantity_delta,
                   'applied',
                   'quick-eval:' || substr(NEW.related_id, 12) || ':inventory-history:' || NEW.id,
                   json_object('item_id', NEW.item_id)
               );
             END`,
    }),
    Object.freeze({
        table: 'clover_squad_star_transactions',
        sql: `CREATE TRIGGER IF NOT EXISTS trg_quick_eval_effect_squad_stars
             AFTER INSERT ON clover_squad_star_transactions
             WHEN NEW.related_id LIKE 'quick_eval:%' AND NEW.amount > 0
             BEGIN
               INSERT OR IGNORE INTO clover_quick_evaluation_effects
               (evaluation_id, effect_type, effect_ref, amount, status, idempotency_key, metadata_json)
               VALUES (CAST(substr(NEW.related_id, 12) AS INTEGER), 'squad_stars', CAST(NEW.id AS TEXT), NEW.amount, 'applied',
                       'quick-eval:' || substr(NEW.related_id, 12) || ':squad-stars:' || NEW.id, '{}');
             END`,
    }),
    Object.freeze({
        table: 'clover_admin_service_entries',
        sql: `CREATE TRIGGER IF NOT EXISTS trg_quick_eval_effect_admin_service
             AFTER INSERT ON clover_admin_service_entries
             WHEN NEW.evaluation_id IS NOT NULL
             BEGIN
               INSERT OR IGNORE INTO clover_quick_evaluation_effects
               (evaluation_id, effect_type, effect_ref, amount, status, idempotency_key, metadata_json)
               VALUES (NEW.evaluation_id, 'admin_service', CAST(NEW.id AS TEXT), NEW.points, 'applied',
                       'quick-eval:' || NEW.evaluation_id || ':admin-service:' || NEW.id,
                       json_object('paid_points', NEW.paid_points, 'service_status', NEW.status));
             END`,
    }),
    Object.freeze({
        table: 'clover_antighost_events',
        sql: `CREATE TRIGGER IF NOT EXISTS trg_quick_eval_effect_antighost_event
             AFTER INSERT ON clover_antighost_events
             WHEN NEW.event_type = 'evaluation'
               AND json_extract(COALESCE(NEW.metadata_json, '{}'), '$.evaluation_id') IS NOT NULL
             BEGIN
               INSERT OR IGNORE INTO clover_quick_evaluation_effects
               (evaluation_id, effect_type, effect_ref, amount, status, idempotency_key, metadata_json)
               VALUES (
                   CAST(json_extract(NEW.metadata_json, '$.evaluation_id') AS INTEGER),
                   'antighost_event',
                   CAST(NEW.id AS TEXT),
                   NULL,
                   'applied',
                   'quick-eval:' || json_extract(NEW.metadata_json, '$.evaluation_id') || ':antighost-event:' || NEW.id,
                   '{}'
               );
             END`,
    }),
    Object.freeze({
        table: 'clover_recruitment_referrals',
        sql: `CREATE TRIGGER IF NOT EXISTS trg_quick_eval_effect_recruitment
             AFTER UPDATE OF validation_evaluation_id ON clover_recruitment_referrals
             WHEN NEW.validation_evaluation_id IS NOT NULL
               AND COALESCE(OLD.validation_evaluation_id, -1) <> NEW.validation_evaluation_id
             BEGIN
               INSERT OR IGNORE INTO clover_quick_evaluation_effects
               (evaluation_id, effect_type, effect_ref, amount, status, idempotency_key, metadata_json)
               VALUES (
                   NEW.validation_evaluation_id,
                   'recruitment',
                   CAST(NEW.id AS TEXT),
                   NULL,
                   'applied',
                   'quick-eval:' || NEW.validation_evaluation_id || ':recruitment:' || NEW.id,
                   json_object('referral_status', NEW.status)
               );
             END`,
    }),
]);

async function createEffectCaptureTriggers(db) {
    for (const spec of EFFECT_TRIGGER_SPECS) {
        if (await tableExists(db, spec.table)) {
            await db.exec(spec.sql);
        }
    }
}

const SCENE_EVALUATION_INTEGRITY_MIGRATION = Object.freeze({
    version: SCENE_EVALUATION_INTEGRITY_VERSION,
    key: SCENE_EVALUATION_INTEGRITY_KEY,
    description: 'Adiciona estado aplicado/anulado, manifesto de efeitos e correcoes append-only das avaliacoes de cena.',
    checksumMaterial: Object.freeze({
        columns: QUICK_EVALUATION_STATUS_COLUMNS,
        effectsTable: EFFECTS_TABLE_SQL.replace(/\s+/g, ' ').trim(),
        effectsIndex: EFFECT_INDEX_SQL.replace(/\s+/g, ' ').trim(),
        correctionsTable: CORRECTIONS_TABLE_SQL.replace(/\s+/g, ' ').trim(),
        correctionsIndex: CORRECTION_INDEX_SQL.replace(/\s+/g, ' ').trim(),
        correctionTriggers: CORRECTION_IMMUTABILITY_TRIGGERS.map((sql) => sql.replace(/\s+/g, ' ').trim()),
        effectTriggers: EFFECT_TRIGGER_SPECS.map((spec) => ({
            table: spec.table,
            sql: spec.sql.replace(/\s+/g, ' ').trim(),
        })),
        revision: 'scene-evaluation-integrity-v2',
    }),
    async up(db) {
        for (const target of QUICK_EVALUATION_STATUS_COLUMNS) {
            await addColumnIfMissing(db, target);
        }
        await db.exec(EFFECTS_TABLE_SQL);
        await db.exec(EFFECT_INDEX_SQL);
        await db.exec(CORRECTIONS_TABLE_SQL);
        await db.exec(CORRECTION_INDEX_SQL);
        for (const sql of CORRECTION_IMMUTABILITY_TRIGGERS) await db.exec(sql);
        await createEffectCaptureTriggers(db);
        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_clover_quick_eval_status_week_player
            ON clover_quick_evaluations (status, week_key, player_id)
        `);
    },
});

const SCHEMA_MIGRATION_EXTENSIONS = Object.freeze([
    SCENE_EVALUATION_INTEGRITY_MIGRATION,
]);

module.exports = {
    CORRECTIONS_TABLE_SQL,
    EFFECTS_TABLE_SQL,
    EFFECT_TRIGGER_SPECS,
    SCENE_EVALUATION_INTEGRITY_KEY,
    SCENE_EVALUATION_INTEGRITY_MIGRATION,
    SCENE_EVALUATION_INTEGRITY_VERSION,
    SCHEMA_MIGRATION_EXTENSIONS,
    createEffectCaptureTriggers,
};
