'use strict';

const GLOBAL_RESET_CHILD_EVENT_GUARD_VERSION = 33;
const GLOBAL_RESET_CHILD_EVENT_GUARD_KEY = '0033_global_reset_child_event_guard';

const GLOBAL_RESET_CHILD_EVENT_GUARD_OBJECTS = Object.freeze([
    Object.freeze({
        type: 'trigger',
        name: 'trg_global_reset_child_event_insert_guard',
        table: 'clover_player_reset_events',
        sql: `
CREATE TRIGGER trg_global_reset_child_event_insert_guard
BEFORE INSERT ON clover_player_reset_events
WHEN NEW.operation_code LIKE 'RS-G-%'
AND (
    COALESCE(NEW.scope, '') <> 'character'
    OR COALESCE(NEW.status, '') <> 'applied'
    OR TRIM(COALESCE(NEW.created_by, '')) = ''
    OR json_valid(NEW.before_json) <> 1
    OR COALESCE(json_extract(NEW.before_json, '$.player.id'), '') <> NEW.player_id
    OR json_valid(NEW.after_json) <> 1
    OR COALESCE(json_extract(NEW.after_json, '$.player.id'), '') <> NEW.player_id
    OR COALESCE(json_extract(NEW.after_json, '$.player.personagem_nome'), '') <> '-'
    OR COALESCE(json_extract(NEW.after_json, '$.player.jogo_status'), '') <> 'bloqueado'
    OR COALESCE(json_type(NEW.after_json, '$.tables'), '') <> 'object'
    OR EXISTS (
        SELECT 1 FROM json_each(NEW.after_json, '$.tables')
        WHERE COALESCE(json_type(value), '') <> 'array'
           OR COALESCE(json_array_length(value), -1) <> 0
    )
    OR COALESCE(json_type(NEW.after_json, '$.queueEntries'), '') <> 'array'
    OR COALESCE(json_array_length(NEW.after_json, '$.queueEntries'), -1) <> 0
    OR COALESCE(json_type(NEW.after_json, '$.reservations'), '') <> 'array'
    OR COALESCE(json_array_length(NEW.after_json, '$.reservations'), -1) <> 0
    OR COALESCE(json_type(NEW.after_json, '$.leadership'), '') <> 'array'
    OR COALESCE(json_array_length(NEW.after_json, '$.leadership'), -1) <> 0
    OR json_valid(COALESCE(NEW.result_json, '')) <> 1
    OR COALESCE(json_type(NEW.result_json), '') <> 'object'
    OR COALESCE(json_extract(NEW.result_json, '$.preserved.playerId'), 0) <> 1
    OR COALESCE(json_extract(NEW.result_json, '$.deletedRows'), -1) < 0
    OR NOT EXISTS (
        SELECT 1
        FROM jogadores p
        WHERE p.id = NEW.player_id
          AND TRIM(COALESCE(p.personagem_nome, '')) = '-'
          AND COALESCE(p.jogo_status, '') = 'bloqueado'
    )
    OR NOT EXISTS (
        SELECT 1
        FROM clover_global_player_reset_items i
        JOIN clover_global_player_reset_operations o ON o.operation_id = i.operation_id
        JOIN clover_global_player_reset_lock l
          ON l.operation_id = o.operation_id
         AND l.lock_key = 'global_character_reset'
        WHERE i.reset_operation_code = NEW.operation_code
          AND i.player_id = NEW.player_id
          AND i.status = 'processing'
          AND o.status = 'running'
          AND o.execution_token IS NOT NULL
          AND TRIM(o.execution_token) <> ''
          AND o.reason = NEW.reason
    )
)
BEGIN
    SELECT RAISE(ABORT, 'global_reset_child_event_guard');
END
`,
    }),
    Object.freeze({
        type: 'trigger',
        name: 'trg_global_reset_child_event_evidence_frozen',
        table: 'clover_player_reset_events',
        sql: `
CREATE TRIGGER trg_global_reset_child_event_evidence_frozen
BEFORE UPDATE OF
    operation_code,
    player_id,
    scope,
    reason,
    created_by,
    before_json,
    after_json,
    result_json,
    created_at
ON clover_player_reset_events
WHEN (OLD.operation_code LIKE 'RS-G-%' OR NEW.operation_code LIKE 'RS-G-%')
AND (
    NEW.operation_code IS NOT OLD.operation_code
    OR NEW.player_id IS NOT OLD.player_id
    OR NEW.scope IS NOT OLD.scope
    OR NEW.reason IS NOT OLD.reason
    OR NEW.created_by IS NOT OLD.created_by
    OR NEW.before_json IS NOT OLD.before_json
    OR NEW.after_json IS NOT OLD.after_json
    OR NEW.result_json IS NOT OLD.result_json
    OR NEW.created_at IS NOT OLD.created_at
)
BEGIN
    SELECT RAISE(ABORT, 'global_reset_child_event_evidence_frozen');
END
`,
    }),
    Object.freeze({
        type: 'trigger',
        name: 'trg_global_reset_child_event_no_delete',
        table: 'clover_player_reset_events',
        sql: `
CREATE TRIGGER trg_global_reset_child_event_no_delete
BEFORE DELETE ON clover_player_reset_events
WHEN OLD.operation_code LIKE 'RS-G-%'
BEGIN
    SELECT RAISE(ABORT, 'global_reset_child_event_delete_forbidden');
END
`,
    }),
]);

function normalizeGlobalResetChildEventGuardSql(sql) {
    return String(sql || '')
        .replace(/\bIF\s+NOT\s+EXISTS\b/gi, '')
        .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '$1')
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),;])\s*/g, '$1')
        .trim()
        .toLowerCase();
}

async function inspectGlobalResetChildEventGuardSchemaState(db) {
    const names = GLOBAL_RESET_CHILD_EVENT_GUARD_OBJECTS.map((entry) => entry.name);
    const placeholders = names.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name IN (${placeholders})`,
        names
    );
    const byName = new Map(rows.map((row) => [row.name, row]));
    const objects = GLOBAL_RESET_CHILD_EVENT_GUARD_OBJECTS.map((expected) => {
        const observed = byName.get(expected.name) || null;
        const exact = Boolean(observed)
            && observed.type === expected.type
            && observed.tbl_name === expected.table
            && normalizeGlobalResetChildEventGuardSql(observed.sql) === normalizeGlobalResetChildEventGuardSql(expected.sql);
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

async function inspectGlobalResetChildEventGuardDataState(db) {
    const row = await db.get(
        `SELECT COUNT(*) AS global_event_count
         FROM clover_player_reset_events
         WHERE operation_code LIKE 'RS-G-%'`
    );
    const globalEventCount = Number(row?.global_event_count || 0);
    return Object.freeze({
        kind: globalEventCount === 0 ? 'empty' : 'nonempty',
        globalEventCount,
    });
}

async function createGlobalResetChildEventGuardObjects(db) {
    for (const object of GLOBAL_RESET_CHILD_EVENT_GUARD_OBJECTS) await db.exec(object.sql);
}

const GLOBAL_RESET_CHILD_EVENT_GUARD_MIGRATION = Object.freeze({
    version: GLOBAL_RESET_CHILD_EVENT_GUARD_VERSION,
    key: GLOBAL_RESET_CHILD_EVENT_GUARD_KEY,
    description: 'Vincula inserts RS-G ao journal global ativo e ao estado persistido de reset, congelando a evidência sem bloquear metadados de restore.',
    checksumMaterial: Object.freeze({
        objects: GLOBAL_RESET_CHILD_EVENT_GUARD_OBJECTS,
        acceptedLegacySchemaLineage: ['absent', 'exact'],
        acceptedLegacyDataLineage: ['empty'],
        revision: 'global-reset-child-event-guard-fail-closed-v2',
    }),
    async up(db) {
        const dataState = await inspectGlobalResetChildEventGuardDataState(db);
        if (dataState.kind !== 'empty') {
            const error = new Error('Eventos RS-G existentes exigem reconciliacao explicita antes da migration 0033.');
            error.code = 'global_reset_child_event_guard_data_reconciliation_required';
            error.state = dataState;
            throw error;
        }

        const before = await inspectGlobalResetChildEventGuardSchemaState(db);
        if (before.kind === 'exact') return;
        if (before.kind !== 'absent') {
            const error = new Error('Triggers do guard de child event global parciais/divergentes exigem reconciliacao explicita.');
            error.code = 'global_reset_child_event_guard_mapping_required';
            error.state = before;
            throw error;
        }
        await createGlobalResetChildEventGuardObjects(db);
        const after = await inspectGlobalResetChildEventGuardSchemaState(db);
        if (after.kind !== 'exact') {
            const error = new Error('Migration 0033 nao produziu os triggers canonicos de child event global.');
            error.code = 'global_reset_child_event_guard_mapping_required';
            error.state = after;
            throw error;
        }
    },
});

module.exports = {
    GLOBAL_RESET_CHILD_EVENT_GUARD_KEY,
    GLOBAL_RESET_CHILD_EVENT_GUARD_MIGRATION,
    GLOBAL_RESET_CHILD_EVENT_GUARD_OBJECTS,
    GLOBAL_RESET_CHILD_EVENT_GUARD_VERSION,
    createGlobalResetChildEventGuardObjects,
    inspectGlobalResetChildEventGuardDataState,
    inspectGlobalResetChildEventGuardSchemaState,
    normalizeGlobalResetChildEventGuardSql,
};
