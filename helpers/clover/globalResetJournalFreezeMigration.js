'use strict';

const GLOBAL_RESET_JOURNAL_FREEZE_VERSION = 32;
const GLOBAL_RESET_JOURNAL_FREEZE_KEY = '0032_global_reset_journal_freeze';

const GLOBAL_RESET_JOURNAL_FREEZE_OBJECTS = Object.freeze([
    Object.freeze({
        type: 'trigger',
        name: 'trg_global_player_reset_operations_frozen_update',
        table: 'clover_global_player_reset_operations',
        sql: `
CREATE TRIGGER trg_global_player_reset_operations_frozen_update
BEFORE UPDATE OF
    operation_id,
    failure_policy,
    reason,
    created_by,
    selection_source,
    population_hash,
    selected_count,
    expected_count,
    skipped_count,
    created_at,
    metadata_json
ON clover_global_player_reset_operations
WHEN
    NEW.operation_id IS NOT OLD.operation_id OR
    NEW.failure_policy IS NOT OLD.failure_policy OR
    NEW.reason IS NOT OLD.reason OR
    NEW.created_by IS NOT OLD.created_by OR
    NEW.selection_source IS NOT OLD.selection_source OR
    NEW.population_hash IS NOT OLD.population_hash OR
    NEW.selected_count IS NOT OLD.selected_count OR
    NEW.expected_count IS NOT OLD.expected_count OR
    NEW.skipped_count IS NOT OLD.skipped_count OR
    NEW.created_at IS NOT OLD.created_at OR
    NEW.metadata_json IS NOT OLD.metadata_json
BEGIN
    SELECT RAISE(ABORT, 'global_reset_operation_frozen');
END
`,
    }),
    Object.freeze({
        type: 'trigger',
        name: 'trg_global_player_reset_operations_no_delete',
        table: 'clover_global_player_reset_operations',
        sql: `
CREATE TRIGGER trg_global_player_reset_operations_no_delete
BEFORE DELETE ON clover_global_player_reset_operations
BEGIN
    SELECT RAISE(ABORT, 'global_reset_operation_delete_forbidden');
END
`,
    }),
    Object.freeze({
        type: 'trigger',
        name: 'trg_global_player_reset_items_frozen_update',
        table: 'clover_global_player_reset_items',
        sql: `
CREATE TRIGGER trg_global_player_reset_items_frozen_update
BEFORE UPDATE OF
    operation_id,
    player_id,
    ordinal,
    reset_operation_code,
    planned_snapshot_sha256,
    preview_json
ON clover_global_player_reset_items
WHEN
    NEW.operation_id IS NOT OLD.operation_id OR
    NEW.player_id IS NOT OLD.player_id OR
    NEW.ordinal IS NOT OLD.ordinal OR
    NEW.reset_operation_code IS NOT OLD.reset_operation_code OR
    NEW.planned_snapshot_sha256 IS NOT OLD.planned_snapshot_sha256 OR
    NEW.preview_json IS NOT OLD.preview_json
BEGIN
    SELECT RAISE(ABORT, 'global_reset_item_frozen');
END
`,
    }),
    Object.freeze({
        type: 'trigger',
        name: 'trg_global_player_reset_items_no_delete',
        table: 'clover_global_player_reset_items',
        sql: `
CREATE TRIGGER trg_global_player_reset_items_no_delete
BEFORE DELETE ON clover_global_player_reset_items
BEGIN
    SELECT RAISE(ABORT, 'global_reset_item_delete_forbidden');
END
`,
    }),
    Object.freeze({
        type: 'trigger',
        name: 'trg_global_player_reset_items_population_sealed',
        table: 'clover_global_player_reset_items',
        sql: `
CREATE TRIGGER trg_global_player_reset_items_population_sealed
BEFORE INSERT ON clover_global_player_reset_items
WHEN
    NOT EXISTS (
        SELECT 1
        FROM clover_global_player_reset_operations
        WHERE operation_id = NEW.operation_id
          AND status = 'planned'
    )
    OR EXISTS (
        SELECT 1
        FROM clover_global_player_reset_lock
        WHERE operation_id = NEW.operation_id
    )
BEGIN
    SELECT RAISE(ABORT, 'global_reset_population_sealed');
END
`,
    }),
    Object.freeze({
        type: 'trigger',
        name: 'trg_global_player_reset_lock_no_update',
        table: 'clover_global_player_reset_lock',
        sql: `
CREATE TRIGGER trg_global_player_reset_lock_no_update
BEFORE UPDATE ON clover_global_player_reset_lock
BEGIN
    SELECT RAISE(ABORT, 'global_reset_lock_update_forbidden');
END
`,
    }),
]);

const GLOBAL_RESET_ACTIVE_LOCK_DELETE_TRIGGER = Object.freeze({
    type: 'trigger',
    name: 'trg_global_player_reset_lock_no_delete_active',
    table: 'clover_global_player_reset_lock',
    sql: `
CREATE TRIGGER trg_global_player_reset_lock_no_delete_active
BEFORE DELETE ON clover_global_player_reset_lock
WHEN NOT EXISTS (
    SELECT 1
    FROM clover_global_player_reset_operations
    WHERE operation_id = OLD.operation_id
      AND status = 'aborted'
)
BEGIN
    SELECT RAISE(ABORT, 'global_reset_lock_delete_forbidden');
END
`,
});

const ALL_GLOBAL_RESET_JOURNAL_FREEZE_OBJECTS = Object.freeze([
    ...GLOBAL_RESET_JOURNAL_FREEZE_OBJECTS,
    GLOBAL_RESET_ACTIVE_LOCK_DELETE_TRIGGER,
]);

function normalizeGlobalResetFreezeSql(sql) {
    return String(sql || '')
        .replace(/\bIF\s+NOT\s+EXISTS\b/gi, '')
        .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '$1')
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),;])\s*/g, '$1')
        .trim()
        .toLowerCase();
}

async function inspectGlobalResetJournalFreezeSchemaState(db) {
    const names = ALL_GLOBAL_RESET_JOURNAL_FREEZE_OBJECTS.map((entry) => entry.name);
    const placeholders = names.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT type, name, tbl_name, sql
         FROM sqlite_schema
         WHERE name IN (${placeholders})`,
        names
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    const objects = ALL_GLOBAL_RESET_JOURNAL_FREEZE_OBJECTS.map((expected) => {
        const observed = byName.get(expected.name) || null;
        const exact = Boolean(observed)
            && observed.type === expected.type
            && observed.tbl_name === expected.table
            && normalizeGlobalResetFreezeSql(observed.sql) === normalizeGlobalResetFreezeSql(expected.sql);
        return Object.freeze({
            name: expected.name,
            table: expected.table,
            exists: Boolean(observed),
            exact,
        });
    });
    if (objects.every((entry) => !entry.exists)) return Object.freeze({ kind: 'absent', objects });
    if (objects.every((entry) => entry.exact)) return Object.freeze({ kind: 'exact', objects });
    return Object.freeze({ kind: 'partial_or_divergent', objects });
}

async function inspectGlobalResetJournalFreezeDataState(db) {
    const row = await db.get(`
        SELECT
            (SELECT COUNT(*) FROM clover_global_player_reset_operations) AS operation_count,
            (SELECT COUNT(*) FROM clover_global_player_reset_items) AS item_count,
            (SELECT COUNT(*) FROM clover_global_player_reset_lock) AS lock_count
    `);
    const counts = Object.freeze({
        operationCount: Number(row?.operation_count || 0),
        itemCount: Number(row?.item_count || 0),
        lockCount: Number(row?.lock_count || 0),
    });
    return Object.freeze({
        kind: counts.operationCount === 0 && counts.itemCount === 0 && counts.lockCount === 0
            ? 'empty'
            : 'nonempty',
        counts,
    });
}

async function createGlobalResetJournalFreezeObjects(db) {
    for (const object of ALL_GLOBAL_RESET_JOURNAL_FREEZE_OBJECTS) await db.exec(object.sql);
}

const GLOBAL_RESET_JOURNAL_FREEZE_MIGRATION = Object.freeze({
    version: GLOBAL_RESET_JOURNAL_FREEZE_VERSION,
    key: GLOBAL_RESET_JOURNAL_FREEZE_KEY,
    description: 'Congela metadados/população do dry-run global e impede mutação/destruição silenciosa do journal após planejamento.',
    checksumMaterial: Object.freeze({
        coreObjects: GLOBAL_RESET_JOURNAL_FREEZE_OBJECTS,
        activeLockDeleteTrigger: GLOBAL_RESET_ACTIVE_LOCK_DELETE_TRIGGER,
        acceptedLegacySchemaLineage: ['absent', 'exact'],
        acceptedLegacyDataLineage: ['empty'],
        revision: 'global-reset-journal-freeze-fail-closed-v4',
    }),
    async up(db) {
        const dataState = await inspectGlobalResetJournalFreezeDataState(db);
        if (dataState.kind !== 'empty') {
            const error = new Error('Journal global existente precisa de reconciliacao explicita antes da migration 0032.');
            error.code = 'global_reset_journal_freeze_data_reconciliation_required';
            error.state = dataState;
            throw error;
        }

        const before = await inspectGlobalResetJournalFreezeSchemaState(db);
        if (before.kind === 'exact') return;
        if (before.kind !== 'absent') {
            const error = new Error('Triggers de freeze do reset global parciais/divergentes exigem reconciliacao explicita.');
            error.code = 'global_reset_journal_freeze_mapping_required';
            error.state = before;
            throw error;
        }
        await createGlobalResetJournalFreezeObjects(db);
        const after = await inspectGlobalResetJournalFreezeSchemaState(db);
        if (after.kind !== 'exact') {
            const error = new Error('Migration 0032 nao produziu os triggers canonicos de freeze do reset global.');
            error.code = 'global_reset_journal_freeze_mapping_required';
            error.state = after;
            throw error;
        }
    },
});

module.exports = {
    ALL_GLOBAL_RESET_JOURNAL_FREEZE_OBJECTS,
    GLOBAL_RESET_ACTIVE_LOCK_DELETE_TRIGGER,
    GLOBAL_RESET_JOURNAL_FREEZE_KEY,
    GLOBAL_RESET_JOURNAL_FREEZE_MIGRATION,
    GLOBAL_RESET_JOURNAL_FREEZE_OBJECTS,
    GLOBAL_RESET_JOURNAL_FREEZE_VERSION,
    createGlobalResetJournalFreezeObjects,
    inspectGlobalResetJournalFreezeDataState,
    inspectGlobalResetJournalFreezeSchemaState,
    normalizeGlobalResetFreezeSql,
};
