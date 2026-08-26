'use strict';

const CLOVER_SCRIPT_JOURNAL_VERSION = 31;
const CLOVER_SCRIPT_JOURNAL_KEY = '0031_clover_script_journal_foundation';

const CLOVER_SCRIPT_JOURNAL_OBJECTS = Object.freeze([
    Object.freeze({
        type: 'table',
        name: 'clover_script_runs',
        sql: `
CREATE TABLE clover_script_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    batch_id TEXT DEFAULT NULL,
    batch_name TEXT DEFAULT NULL,
    mode TEXT DEFAULT 'rigido',
    script_hash TEXT NOT NULL,
    script_text TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'simulated',
    created_by TEXT DEFAULT NULL,
    applied_by TEXT DEFAULT NULL,
    chat_id TEXT DEFAULT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    applied_at TEXT DEFAULT NULL,
    error TEXT DEFAULT NULL,
    metadata_json TEXT DEFAULT NULL
)
`,
    }),
    Object.freeze({
        type: 'index',
        name: 'idx_clover_script_runs_status',
        table: 'clover_script_runs',
        sql: `
CREATE INDEX idx_clover_script_runs_status
ON clover_script_runs (status, created_by, chat_id, created_at DESC)
`,
    }),
    Object.freeze({
        type: 'index',
        name: 'idx_clover_script_runs_batch_applied',
        table: 'clover_script_runs',
        sql: `
CREATE UNIQUE INDEX idx_clover_script_runs_batch_applied
ON clover_script_runs (batch_id)
WHERE status = 'applied' AND batch_id IS NOT NULL
`,
    }),
    Object.freeze({
        type: 'table',
        name: 'clover_script_actions',
        sql: `
CREATE TABLE clover_script_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    player_id TEXT DEFAULT NULL,
    action_type TEXT NOT NULL,
    summary TEXT DEFAULT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT DEFAULT NULL,
    before_json TEXT DEFAULT NULL,
    after_json TEXT DEFAULT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
)
`,
    }),
]);

function normalizeCloverScriptSchemaSql(sql) {
    return String(sql || '')
        .replace(/\bIF\s+NOT\s+EXISTS\b/gi, '')
        .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '$1')
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),])\s*/g, '$1')
        .trim()
        .toLowerCase();
}

async function inspectCloverScriptJournalSchemaState(db) {
    const names = CLOVER_SCRIPT_JOURNAL_OBJECTS.map((entry) => entry.name);
    const placeholders = names.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name IN (${placeholders})`,
        names
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    const objects = CLOVER_SCRIPT_JOURNAL_OBJECTS.map((expected) => {
        const observed = byName.get(expected.name) || null;
        const exact = Boolean(observed)
            && observed.type === expected.type
            && (expected.type !== 'index' || observed.tbl_name === expected.table)
            && normalizeCloverScriptSchemaSql(observed.sql) === normalizeCloverScriptSchemaSql(expected.sql);
        return Object.freeze({ name: expected.name, exists: Boolean(observed), exact });
    });
    if (objects.every((entry) => !entry.exists)) return Object.freeze({ kind: 'absent', objects });
    if (objects.every((entry) => entry.exact)) return Object.freeze({ kind: 'exact', objects });
    return Object.freeze({ kind: 'partial_or_divergent', objects });
}

async function createCloverScriptJournalObjects(db) {
    for (const object of CLOVER_SCRIPT_JOURNAL_OBJECTS) await db.exec(object.sql);
}

const CLOVER_SCRIPT_JOURNAL_MIGRATION = Object.freeze({
    version: CLOVER_SCRIPT_JOURNAL_VERSION,
    key: CLOVER_SCRIPT_JOURNAL_KEY,
    description: 'Formaliza o journal do CloverScript usado pelo caminho de reset e remove DDL pós-fingerprint do runtime canônico.',
    checksumMaterial: Object.freeze({
        objects: CLOVER_SCRIPT_JOURNAL_OBJECTS,
        acceptedLegacyLineage: ['absent', 'exact'],
        revision: 'clover-script-journal-foundation-fail-closed-v1',
    }),
    async up(db) {
        const before = await inspectCloverScriptJournalSchemaState(db);
        if (before.kind === 'exact') return;
        if (before.kind !== 'absent') {
            const error = new Error('Schema do journal CloverScript parcial ou divergente exige reconciliacao explicita.');
            error.code = 'clover_script_schema_mapping_required';
            error.state = before;
            throw error;
        }
        await createCloverScriptJournalObjects(db);
        const after = await inspectCloverScriptJournalSchemaState(db);
        if (after.kind !== 'exact') {
            const error = new Error('Migration 0031 nao produziu o schema canonico do journal CloverScript.');
            error.code = 'clover_script_schema_mapping_required';
            error.state = after;
            throw error;
        }
    },
});

module.exports = {
    CLOVER_SCRIPT_JOURNAL_KEY,
    CLOVER_SCRIPT_JOURNAL_MIGRATION,
    CLOVER_SCRIPT_JOURNAL_OBJECTS,
    CLOVER_SCRIPT_JOURNAL_VERSION,
    inspectCloverScriptJournalSchemaState,
    normalizeCloverScriptSchemaSql,
};
