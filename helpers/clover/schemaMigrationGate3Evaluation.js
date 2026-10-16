'use strict';

const UNIVERSAL_EVALUATION_VERSION = 33;
const UNIVERSAL_EVALUATION_KEY = '0033_universal_evaluation_queue';

const SUBMISSIONS_TABLE_SQL = `
CREATE TABLE clover_evaluation_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    protocol TEXT DEFAULT NULL UNIQUE,
    submission_key TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    player_id TEXT NOT NULL,
    whatsapp_jid TEXT NOT NULL,
    character_id TEXT DEFAULT NULL,
    character_name_snapshot TEXT DEFAULT NULL,
    original_payload TEXT NOT NULL,
    original_payload_hash TEXT NOT NULL,
    final_payload TEXT DEFAULT NULL,
    final_payload_hash TEXT DEFAULT NULL,
    status TEXT NOT NULL DEFAULT 'waiting'
        CHECK (status IN ('waiting','reviewing','approved','denied','cancelled','awaiting_followup')),
    reviewer_id TEXT DEFAULT NULL,
    decision_reason TEXT DEFAULT NULL,
    source_chat_id TEXT DEFAULT NULL,
    source_message_id TEXT DEFAULT NULL,
    source_quoted_message_id TEXT DEFAULT NULL,
    submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    review_started_at TEXT DEFAULT NULL,
    resolved_at TEXT DEFAULT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata_json TEXT NOT NULL DEFAULT '{}'
)`;

const EVENTS_TABLE_SQL = `
CREATE TABLE clover_evaluation_submission_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    actor_id TEXT DEFAULT NULL,
    from_status TEXT DEFAULT NULL,
    to_status TEXT DEFAULT NULL,
    reason TEXT DEFAULT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (submission_id) REFERENCES clover_evaluation_submissions(id)
)`;

const EVALUATION_INDEXES = Object.freeze([
    `CREATE INDEX idx_clover_eval_waiting_global
     ON clover_evaluation_submissions (status, submitted_at ASC, id ASC)`,
    `CREATE INDEX idx_clover_eval_waiting_category
     ON clover_evaluation_submissions (status, category, submitted_at ASC, id ASC)`,
    `CREATE INDEX idx_clover_eval_player
     ON clover_evaluation_submissions (player_id, status, submitted_at DESC, id DESC)`,
    `CREATE INDEX idx_clover_eval_reviewer
     ON clover_evaluation_submissions (reviewer_id, status, review_started_at ASC, id ASC)`,
    `CREATE INDEX idx_clover_eval_events_submission
     ON clover_evaluation_submission_events (submission_id, created_at ASC, id ASC)`,
]);

const EVALUATION_TRIGGERS = Object.freeze([
    `CREATE TRIGGER trg_clover_eval_protocol_assign
     AFTER INSERT ON clover_evaluation_submissions
     WHEN NEW.protocol IS NULL
     BEGIN
         UPDATE clover_evaluation_submissions
         SET protocol = 'A' || NEW.id
         WHERE id = NEW.id AND protocol IS NULL;
     END`,
    `CREATE TRIGGER trg_clover_eval_protocol_immutable
     BEFORE UPDATE OF protocol ON clover_evaluation_submissions
     WHEN OLD.protocol IS NOT NULL AND (NEW.protocol IS NULL OR NEW.protocol <> OLD.protocol)
     BEGIN
         SELECT RAISE(ABORT, 'evaluation_protocol_immutable');
     END`,
    `CREATE TRIGGER trg_clover_eval_original_identity_immutable
     BEFORE UPDATE OF submission_key, category, player_id, whatsapp_jid, character_id,
                      character_name_snapshot, original_payload, original_payload_hash,
                      source_chat_id, source_message_id, source_quoted_message_id, submitted_at
     ON clover_evaluation_submissions
     BEGIN
         SELECT RAISE(ABORT, 'evaluation_original_submission_immutable');
     END`,
    `CREATE TRIGGER trg_clover_eval_status_transition_guard
     BEFORE UPDATE OF status ON clover_evaluation_submissions
     WHEN NEW.status <> OLD.status
      AND NOT (
          (OLD.status = 'waiting' AND NEW.status IN ('reviewing','cancelled'))
          OR (OLD.status = 'reviewing' AND NEW.status IN ('waiting','approved','denied','awaiting_followup'))
          OR (OLD.status = 'awaiting_followup' AND NEW.status = 'reviewing')
      )
     BEGIN
         SELECT RAISE(ABORT, 'evaluation_invalid_status_transition');
     END`,
    `CREATE TRIGGER trg_clover_eval_terminal_status_immutable
     BEFORE UPDATE OF status ON clover_evaluation_submissions
     WHEN OLD.status IN ('approved','denied','cancelled') AND NEW.status <> OLD.status
     BEGIN
         SELECT RAISE(ABORT, 'evaluation_terminal_status_immutable');
     END`,
    `CREATE TRIGGER trg_clover_eval_terminal_decision_immutable
     BEFORE UPDATE OF final_payload, final_payload_hash, decision_reason,
                      reviewer_id, review_started_at, resolved_at
     ON clover_evaluation_submissions
     WHEN OLD.status IN ('approved','denied','cancelled')
     BEGIN
         SELECT RAISE(ABORT, 'evaluation_terminal_decision_immutable');
     END`,
    `CREATE TRIGGER trg_clover_eval_submission_delete_block
     BEFORE DELETE ON clover_evaluation_submissions
     BEGIN
         SELECT RAISE(ABORT, 'evaluation_submission_immutable');
     END`,
    `CREATE TRIGGER trg_clover_eval_event_immutable_update
     BEFORE UPDATE ON clover_evaluation_submission_events
     BEGIN
         SELECT RAISE(ABORT, 'evaluation_event_immutable');
     END`,
    `CREATE TRIGGER trg_clover_eval_event_immutable_delete
     BEFORE DELETE ON clover_evaluation_submission_events
     BEGIN
         SELECT RAISE(ABORT, 'evaluation_event_immutable');
     END`,
]);

function normalizeSql(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

async function inspectUniversalEvaluationSchema(db) {
    const names = [
        'clover_evaluation_submissions',
        'clover_evaluation_submission_events',
        ...EVALUATION_INDEXES.map((sql) => sql.match(/CREATE INDEX\s+([^\s]+)/i)?.[1]).filter(Boolean),
        ...EVALUATION_TRIGGERS.map((sql) => sql.match(/CREATE TRIGGER\s+([^\s]+)/i)?.[1]).filter(Boolean),
    ];
    const placeholders = names.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT type, name, tbl_name, sql
         FROM sqlite_schema
         WHERE name IN (${placeholders})`,
        names
    );
    return {
        names,
        rows,
        present: new Set(rows.map((row) => row.name)),
    };
}

const UNIVERSAL_EVALUATION_MIGRATION = Object.freeze({
    version: UNIVERSAL_EVALUATION_VERSION,
    key: UNIVERSAL_EVALUATION_KEY,
    description: 'Cria a fila universal FIFO de submissões de avaliação com protocolo permanente, lock de revisor e trilha imutável.',
    checksumMaterial: Object.freeze({
        submissions: normalizeSql(SUBMISSIONS_TABLE_SQL),
        events: normalizeSql(EVENTS_TABLE_SQL),
        indexes: EVALUATION_INDEXES.map(normalizeSql),
        triggers: EVALUATION_TRIGGERS.map(normalizeSql),
        queueInvariant: 'one-global-fifo-many-submissions-per-player-category-is-filter-only',
        selectorInvariant: 'protocol-permanent-global-position-ephemeral-filter-does-not-renumber',
        transitionInvariant: 'waiting-reviewing-terminal-or-followup-explicit-only',
        auditInvariant: 'original-and-terminal-decision-immutable-events-append-only-no-delete',
        revision: 'universal-evaluation-queue-v2',
    }),
    async up(db) {
        const before = await inspectUniversalEvaluationSchema(db);
        if (before.rows.length > 0) {
            const error = new Error('Schema da fila universal já existe parcial ou integralmente sem migration registrada.');
            error.code = 'universal_evaluation_schema_mapping_required';
            error.objects = before.rows.map((row) => row.name);
            throw error;
        }

        await db.exec(SUBMISSIONS_TABLE_SQL);
        await db.exec(EVENTS_TABLE_SQL);
        for (const sql of EVALUATION_INDEXES) await db.exec(sql);
        for (const sql of EVALUATION_TRIGGERS) await db.exec(sql);

        const after = await inspectUniversalEvaluationSchema(db);
        const missing = after.names.filter((name) => !after.present.has(name));
        if (missing.length) {
            const error = new Error('Migration 0033 não produziu todos os objetos da fila universal.');
            error.code = 'universal_evaluation_schema_incomplete';
            error.missing = missing;
            throw error;
        }
    },
});

module.exports = {
    EVALUATION_INDEXES,
    EVALUATION_TRIGGERS,
    EVENTS_TABLE_SQL,
    SUBMISSIONS_TABLE_SQL,
    UNIVERSAL_EVALUATION_KEY,
    UNIVERSAL_EVALUATION_MIGRATION,
    UNIVERSAL_EVALUATION_VERSION,
    inspectUniversalEvaluationSchema,
};
