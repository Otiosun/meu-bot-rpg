'use strict';

const RESET_JOURNAL_VERSION = 30;
const RESET_JOURNAL_KEY = '0030_reset_journal_foundation';

const PLAYER_RESET_JOURNAL_OBJECTS = Object.freeze([
    Object.freeze({
        type: 'table',
        name: 'clover_player_reset_events',
        sql: `
CREATE TABLE clover_player_reset_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_code TEXT NOT NULL UNIQUE,
    player_id TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'character',
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'applied'
        CHECK (status IN ('applied', 'restored')),
    created_by TEXT DEFAULT NULL,
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL,
    result_json TEXT DEFAULT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    restored_at TEXT DEFAULT NULL,
    restored_by TEXT DEFAULT NULL,
    restore_reason TEXT DEFAULT NULL,
    restore_operation_code TEXT DEFAULT NULL
)
`,
    }),
    Object.freeze({
        type: 'index',
        name: 'idx_clover_player_reset_events_player',
        table: 'clover_player_reset_events',
        sql: `
CREATE INDEX idx_clover_player_reset_events_player
ON clover_player_reset_events (player_id, id DESC)
`,
    }),
    Object.freeze({
        type: 'table',
        name: 'clover_player_reset_restores',
        sql: `
CREATE TABLE clover_player_reset_restores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_code TEXT NOT NULL UNIQUE,
    source_event_id INTEGER NOT NULL UNIQUE,
    source_operation_code TEXT NOT NULL,
    player_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_by TEXT DEFAULT NULL,
    before_restore_json TEXT NOT NULL,
    restored_json TEXT NOT NULL,
    result_json TEXT DEFAULT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
)
`,
    }),
    Object.freeze({
        type: 'index',
        name: 'idx_clover_player_reset_restores_player',
        table: 'clover_player_reset_restores',
        sql: `
CREATE INDEX idx_clover_player_reset_restores_player
ON clover_player_reset_restores (player_id, id DESC)
`,
    }),
]);

const GLOBAL_RESET_JOURNAL_OBJECTS = Object.freeze([
    Object.freeze({
        type: 'table',
        name: 'clover_global_player_reset_operations',
        sql: `
CREATE TABLE clover_global_player_reset_operations (
    operation_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'planned'
        CHECK (status IN ('planned','running','paused','completed','reconciled','aborted')),
    failure_policy TEXT NOT NULL DEFAULT 'stop_on_first_error'
        CHECK (failure_policy = 'stop_on_first_error'),
    reason TEXT NOT NULL,
    created_by TEXT NOT NULL,
    selection_source TEXT NOT NULL,
    population_hash TEXT NOT NULL,
    selected_count INTEGER NOT NULL,
    expected_count INTEGER NOT NULL,
    applied_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    reconciled_count INTEGER NOT NULL DEFAULT 0,
    execution_token TEXT DEFAULT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT DEFAULT NULL,
    completed_at TEXT DEFAULT NULL,
    reconciled_at TEXT DEFAULT NULL,
    aborted_at TEXT DEFAULT NULL,
    last_error_json TEXT DEFAULT NULL,
    metadata_json TEXT DEFAULT NULL
)
`,
    }),
    Object.freeze({
        type: 'table',
        name: 'clover_global_player_reset_items',
        sql: `
CREATE TABLE clover_global_player_reset_items (
    operation_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    status TEXT NOT NULL
        CHECK (status IN ('pending','processing','applied','failed','skipped','reconciled')),
    reset_operation_code TEXT NOT NULL UNIQUE,
    planned_snapshot_sha256 TEXT DEFAULT NULL,
    preview_json TEXT DEFAULT NULL,
    result_json TEXT DEFAULT NULL,
    last_error_json TEXT DEFAULT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT DEFAULT NULL,
    finished_at TEXT DEFAULT NULL,
    PRIMARY KEY (operation_id, player_id),
    FOREIGN KEY (operation_id) REFERENCES clover_global_player_reset_operations(operation_id)
)
`,
    }),
    Object.freeze({
        type: 'index',
        name: 'idx_global_player_reset_items_status',
        table: 'clover_global_player_reset_items',
        sql: `
CREATE INDEX idx_global_player_reset_items_status
ON clover_global_player_reset_items (operation_id, status, ordinal)
`,
    }),
    Object.freeze({
        type: 'table',
        name: 'clover_global_player_reset_lock',
        sql: `
CREATE TABLE clover_global_player_reset_lock (
    lock_key TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE,
    acquired_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (operation_id) REFERENCES clover_global_player_reset_operations(operation_id)
)
`,
    }),
]);

const RESET_JOURNAL_OBJECTS = Object.freeze([
    ...PLAYER_RESET_JOURNAL_OBJECTS,
    ...GLOBAL_RESET_JOURNAL_OBJECTS,
]);

function normalizeResetJournalSchemaSql(sql) {
    return String(sql || '')
        .replace(/\bIF\s+NOT\s+EXISTS\b/gi, '')
        .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '$1')
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),])\s*/g, '$1')
        .trim()
        .toLowerCase();
}

async function inspectObjectGroup(db, objects) {
    const names = objects.map((entry) => entry.name);
    const placeholders = names.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name IN (${placeholders})`,
        names
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    const inspected = objects.map((expected) => {
        const observed = byName.get(expected.name) || null;
        const exact = Boolean(observed)
            && observed.type === expected.type
            && (expected.type !== 'index' || observed.tbl_name === expected.table)
            && normalizeResetJournalSchemaSql(observed.sql) === normalizeResetJournalSchemaSql(expected.sql);
        return Object.freeze({ name: expected.name, exists: Boolean(observed), exact });
    });
    if (inspected.every((entry) => !entry.exists)) return Object.freeze({ kind: 'absent', objects: inspected });
    if (inspected.every((entry) => entry.exact)) return Object.freeze({ kind: 'exact', objects: inspected });
    return Object.freeze({ kind: 'partial_or_divergent', objects: inspected });
}

async function inspectResetJournalSchemaState(db) {
    const player = await inspectObjectGroup(db, PLAYER_RESET_JOURNAL_OBJECTS);
    const global = await inspectObjectGroup(db, GLOBAL_RESET_JOURNAL_OBJECTS);
    let kind = 'partial_or_divergent';
    if (player.kind === 'absent' && global.kind === 'absent') kind = 'absent';
    else if (player.kind === 'exact' && global.kind === 'absent') kind = 'player_exact_global_absent';
    else if (player.kind === 'exact' && global.kind === 'exact') kind = 'exact';
    return Object.freeze({ kind, player, global });
}

async function createObjects(db, objects) {
    for (const object of objects) await db.exec(object.sql);
}

const RESET_JOURNAL_MIGRATION = Object.freeze({
    version: RESET_JOURNAL_VERSION,
    key: RESET_JOURNAL_KEY,
    description: 'Formaliza journals individual/global de reset que antes eram DDL runtime fora da chain.',
    checksumMaterial: Object.freeze({
        playerObjects: PLAYER_RESET_JOURNAL_OBJECTS,
        globalObjects: GLOBAL_RESET_JOURNAL_OBJECTS,
        acceptedLegacyLineage: ['absent', 'player_exact_global_absent', 'exact'],
        revision: 'reset-journal-foundation-fail-closed-v1',
    }),
    async up(db) {
        const before = await inspectResetJournalSchemaState(db);
        if (before.kind === 'exact') return;
        if (before.kind === 'absent') {
            await createObjects(db, RESET_JOURNAL_OBJECTS);
        } else if (before.kind === 'player_exact_global_absent') {
            await createObjects(db, GLOBAL_RESET_JOURNAL_OBJECTS);
        } else {
            const error = new Error('Schema de journal de reset parcial ou divergente exige reconciliacao explicita.');
            error.code = 'reset_journal_schema_mapping_required';
            error.state = before;
            throw error;
        }
        const after = await inspectResetJournalSchemaState(db);
        if (after.kind !== 'exact') {
            const error = new Error('Migration 0030 nao produziu o schema canonico de journals de reset.');
            error.code = 'reset_journal_schema_mapping_required';
            error.state = after;
            throw error;
        }
    },
});

module.exports = {
    GLOBAL_RESET_JOURNAL_OBJECTS,
    PLAYER_RESET_JOURNAL_OBJECTS,
    RESET_JOURNAL_KEY,
    RESET_JOURNAL_MIGRATION,
    RESET_JOURNAL_OBJECTS,
    RESET_JOURNAL_VERSION,
    inspectResetJournalSchemaState,
    normalizeResetJournalSchemaSql,
};
