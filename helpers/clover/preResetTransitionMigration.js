'use strict';

const PRE_RESET_TRANSITION_VERSION = 34;
const PRE_RESET_TRANSITION_KEY = '0034_prereset_transition_decision';

const PRE_RESET_TRANSITION_OBJECTS = Object.freeze([
    Object.freeze({
        type: 'table',
        name: 'clover_prereset_transition_decisions',
        table: 'clover_prereset_transition_decisions',
        sql: `
CREATE TABLE clover_prereset_transition_decisions (
    player_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'keep', 'reset', 'auto_reset')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    baseline_json TEXT DEFAULT NULL,
    baseline_hash TEXT DEFAULT NULL,
    decided_by TEXT DEFAULT NULL,
    decision_source TEXT DEFAULT NULL,
    decision_at TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES jogadores(id)
)
`,
    }),
    Object.freeze({
        type: 'table',
        name: 'clover_prereset_transition_operations',
        table: 'clover_prereset_transition_operations',
        sql: `
CREATE TABLE clover_prereset_transition_operations (
    operation_key TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    operation_type TEXT NOT NULL CHECK (operation_type IN ('keep', 'reset', 'auto_reset')),
    request_hash TEXT NOT NULL,
    resulting_status TEXT NOT NULL CHECK (resulting_status IN ('keep', 'reset', 'auto_reset')),
    resulting_revision INTEGER NOT NULL CHECK (resulting_revision >= 1),
    actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (player_id) REFERENCES jogadores(id)
)
`,
    }),
    Object.freeze({
        type: 'index',
        name: 'idx_prereset_transition_status',
        table: 'clover_prereset_transition_decisions',
        sql: `
CREATE INDEX idx_prereset_transition_status
ON clover_prereset_transition_decisions (status, updated_at, player_id)
`,
    }),
    Object.freeze({
        type: 'index',
        name: 'idx_prereset_transition_operations_player',
        table: 'clover_prereset_transition_operations',
        sql: `
CREATE INDEX idx_prereset_transition_operations_player
ON clover_prereset_transition_operations (player_id, created_at)
`,
    }),
    Object.freeze({
        type: 'trigger',
        name: 'trg_prereset_transition_decision_irreversible',
        table: 'clover_prereset_transition_decisions',
        sql: `
CREATE TRIGGER trg_prereset_transition_decision_irreversible
BEFORE UPDATE OF status ON clover_prereset_transition_decisions
WHEN OLD.status IN ('keep', 'reset', 'auto_reset')
AND NEW.status IS NOT OLD.status
BEGIN
    SELECT RAISE(ABORT, 'prereset_transition_decision_irreversible');
END
`,
    }),
    Object.freeze({
        type: 'trigger',
        name: 'trg_prereset_transition_evidence_frozen',
        table: 'clover_prereset_transition_decisions',
        sql: `
CREATE TRIGGER trg_prereset_transition_evidence_frozen
BEFORE UPDATE OF baseline_json, baseline_hash, decided_by, decision_source, decision_at
ON clover_prereset_transition_decisions
WHEN OLD.status IN ('keep', 'reset', 'auto_reset')
AND (
    NEW.baseline_json IS NOT OLD.baseline_json
    OR NEW.baseline_hash IS NOT OLD.baseline_hash
    OR NEW.decided_by IS NOT OLD.decided_by
    OR NEW.decision_source IS NOT OLD.decision_source
    OR NEW.decision_at IS NOT OLD.decision_at
)
BEGIN
    SELECT RAISE(ABORT, 'prereset_transition_evidence_frozen');
END
`,
    }),
    Object.freeze({
        type: 'trigger',
        name: 'trg_prereset_transition_no_delete',
        table: 'clover_prereset_transition_decisions',
        sql: `
CREATE TRIGGER trg_prereset_transition_no_delete
BEFORE DELETE ON clover_prereset_transition_decisions
BEGIN
    SELECT RAISE(ABORT, 'prereset_transition_delete_forbidden');
END
`,
    }),
]);

function normalizeSql(sql) {
    return String(sql || '')
        .replace(/\bIF\s+NOT\s+EXISTS\b/gi, '')
        .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '$1')
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),;])\s*/g, '$1')
        .trim()
        .toLowerCase();
}

async function inspectPreResetTransitionSchemaState(db) {
    const names = PRE_RESET_TRANSITION_OBJECTS.map((entry) => entry.name);
    const placeholders = names.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (${placeholders})`,
        names
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    const objects = PRE_RESET_TRANSITION_OBJECTS.map((expected) => {
        const observed = byName.get(expected.name) || null;
        const exact = Boolean(observed)
            && observed.type === expected.type
            && observed.tbl_name === expected.table
            && normalizeSql(observed.sql) === normalizeSql(expected.sql);
        return Object.freeze({ name: expected.name, exists: Boolean(observed), exact });
    });
    if (objects.every((entry) => !entry.exists)) return Object.freeze({ kind: 'absent', objects });
    if (objects.every((entry) => entry.exact)) return Object.freeze({ kind: 'exact', objects });
    return Object.freeze({ kind: 'partial_or_divergent', objects });
}

async function createPreResetTransitionObjects(db) {
    for (const object of PRE_RESET_TRANSITION_OBJECTS) await db.exec(object.sql);
}

const PRE_RESET_TRANSITION_MIGRATION = Object.freeze({
    version: PRE_RESET_TRANSITION_VERSION,
    key: PRE_RESET_TRANSITION_KEY,
    description: 'Formaliza a decisao irreversivel MANTER/RESETAR/AUTO_RESET sem reutilizar jogo_status.',
    checksumMaterial: Object.freeze({
        objects: PRE_RESET_TRANSITION_OBJECTS,
        acceptedLegacySchemaLineage: ['absent', 'exact'],
        revision: 'prereset-transition-v1',
    }),
    async up(db) {
        const before = await inspectPreResetTransitionSchemaState(db);
        if (before.kind === 'exact') return;
        if (before.kind !== 'absent') {
            const error = new Error('Schema de transicao pre-reset parcial/divergente exige reconciliacao explicita.');
            error.code = 'prereset_transition_schema_reconciliation_required';
            error.state = before;
            throw error;
        }
        await createPreResetTransitionObjects(db);
        const after = await inspectPreResetTransitionSchemaState(db);
        if (after.kind !== 'exact') {
            const error = new Error('Migration 0034 nao produziu o schema canonico de transicao pre-reset.');
            error.code = 'prereset_transition_schema_not_exact';
            error.state = after;
            throw error;
        }
    },
});

module.exports = {
    PRE_RESET_TRANSITION_KEY,
    PRE_RESET_TRANSITION_MIGRATION,
    PRE_RESET_TRANSITION_OBJECTS,
    PRE_RESET_TRANSITION_VERSION,
    createPreResetTransitionObjects,
    inspectPreResetTransitionSchemaState,
    normalizeSql,
};
