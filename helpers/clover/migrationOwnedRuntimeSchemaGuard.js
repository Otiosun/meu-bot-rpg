'use strict';

const { inspectResetJournalSchemaState } = require('./resetJournalSchemaMigration');
const { inspectCloverScriptJournalSchemaState } = require('./cloverScriptSchemaMigration');
const { inspectGlobalResetJournalFreezeSchemaState } = require('./globalResetJournalFreezeMigration');
const { inspectGlobalResetChildEventGuardSchemaState } = require('./globalResetChildEventGuardMigration');

const RUNTIME_SCHEMA_GUARD_SYMBOL = Symbol.for('clover.migrationOwnedRuntimeSchemaGuard');

const CLOVER_SCRIPT_OBJECTS = new Set([
    'clover_script_runs',
    'idx_clover_script_runs_status',
    'idx_clover_script_runs_batch_applied',
    'clover_script_actions',
]);

const RESET_JOURNAL_OBJECTS = new Set([
    'clover_player_reset_events',
    'idx_clover_player_reset_events_player',
    'clover_player_reset_restores',
    'idx_clover_player_reset_restores_player',
    'clover_global_player_reset_operations',
    'clover_global_player_reset_items',
    'idx_global_player_reset_items_status',
    'clover_global_player_reset_lock',
]);

const GLOBAL_RESET_GUARD_OBJECTS = new Set([
    'trg_global_player_reset_operations_frozen_update',
    'trg_global_player_reset_operations_no_delete',
    'trg_global_player_reset_items_frozen_update',
    'trg_global_player_reset_items_no_delete',
    'trg_global_player_reset_items_population_sealed',
    'trg_global_player_reset_lock_no_update',
    'trg_global_player_reset_lock_no_delete_active',
    'trg_global_reset_child_event_insert_guard',
    'trg_global_reset_child_event_evidence_frozen',
    'trg_global_reset_child_event_no_delete',
]);

const GLOBAL_RESET_FOUNDATION_OBJECTS = new Set([
    'clover_global_player_reset_operations',
    'clover_global_player_reset_items',
    'idx_global_player_reset_items_status',
    'clover_global_player_reset_lock',
]);

const PROTECTED_OBJECTS = new Set([
    ...CLOVER_SCRIPT_OBJECTS,
    ...RESET_JOURNAL_OBJECTS,
    ...GLOBAL_RESET_GUARD_OBJECTS,
]);

class MigrationOwnedRuntimeSchemaError extends Error {
    constructor(message, code = 'migration_owned_runtime_schema_error', details = null) {
        super(message || code);
        this.name = 'MigrationOwnedRuntimeSchemaError';
        this.code = code;
        this.details = details || null;
    }
}

function normalizeObjectName(value) {
    return String(value || '')
        .trim()
        .replace(/^[`"'\[]+|[`"'\]]+$/g, '')
        .toLowerCase();
}

function extractSchemaMutationTargets(sql) {
    const source = String(sql || '');
    const targets = [];
    const createDrop = /\b(?:CREATE\s+(?:UNIQUE\s+)?|DROP\s+)(TABLE|INDEX|TRIGGER)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([`"'\[]?[A-Za-z_][A-Za-z0-9_]*[`"'\]]?)/gi;
    const alter = /\bALTER\s+TABLE\s+([`"'\[]?[A-Za-z_][A-Za-z0-9_]*[`"'\]]?)/gi;
    let match = null;
    while ((match = createDrop.exec(source))) targets.push(normalizeObjectName(match[2]));
    while ((match = alter.exec(source))) targets.push(normalizeObjectName(match[1]));
    return [...new Set(targets.filter(Boolean))];
}

function containsSchemaMutation(sql) {
    return /\b(?:CREATE|ALTER|DROP)\b/i.test(String(sql || ''));
}

function protectedObjectMentioned(sql) {
    const source = String(sql || '').toLowerCase();
    for (const name of PROTECTED_OBJECTS) {
        if (source.includes(name)) return true;
    }
    return false;
}

function stateSummary(state) {
    if (!state || typeof state !== 'object') return null;
    if (state.objects) {
        return {
            kind: state.kind,
            objects: state.objects.map((entry) => ({
                name: entry.name,
                exists: entry.exists,
                exact: entry.exact,
            })),
        };
    }
    return {
        kind: state.kind,
        player: state.player ? stateSummary(state.player) : undefined,
        global: state.global ? stateSummary(state.global) : undefined,
    };
}

async function assertCloverScriptRuntimeSchemaExact(db) {
    const state = await inspectCloverScriptJournalSchemaState(db);
    if (state.kind !== 'exact') {
        throw new MigrationOwnedRuntimeSchemaError(
            'Schema 0031 do CloverScript divergiu do contrato migrado; auto-repair em runtime foi bloqueado.',
            'clover_script_runtime_schema_drift',
            { migration: '0031', state: stateSummary(state) }
        );
    }
    return state;
}

async function assertResetJournalRuntimeSchemaExact(db) {
    const state = await inspectResetJournalSchemaState(db);
    if (state.kind !== 'exact') {
        throw new MigrationOwnedRuntimeSchemaError(
            'Schema 0030 dos journals de reset divergiu do contrato migrado; auto-repair em runtime foi bloqueado.',
            'reset_journal_runtime_schema_drift',
            { migration: '0030', state: stateSummary(state) }
        );
    }
    return state;
}

async function assertGlobalResetGuardsRuntimeSchemaExact(db) {
    const [freeze, childEvents] = await Promise.all([
        inspectGlobalResetJournalFreezeSchemaState(db),
        inspectGlobalResetChildEventGuardSchemaState(db),
    ]);
    if (freeze.kind !== 'exact' || childEvents.kind !== 'exact') {
        throw new MigrationOwnedRuntimeSchemaError(
            'Guards 0032/0033 do reset global divergiram; runtime global recusado em modo fail-closed.',
            'global_reset_runtime_guard_drift',
            {
                migrations: ['0032', '0033'],
                freeze: stateSummary(freeze),
                childEvents: stateSummary(childEvents),
            }
        );
    }
    return { freeze, childEvents };
}

async function assertCanonicalResetRuntimeSchemaExact(db) {
    const [script, reset] = await Promise.all([
        assertCloverScriptRuntimeSchemaExact(db),
        assertResetJournalRuntimeSchemaExact(db),
    ]);
    const globalGuards = await assertGlobalResetGuardsRuntimeSchemaExact(db);
    return { script, reset, globalGuards };
}

async function certifyProtectedTargets(db, targets) {
    const targetSet = new Set(targets);
    if ([...targetSet].some((name) => CLOVER_SCRIPT_OBJECTS.has(name))) {
        await assertCloverScriptRuntimeSchemaExact(db);
    }
    if ([...targetSet].some((name) => RESET_JOURNAL_OBJECTS.has(name))) {
        await assertResetJournalRuntimeSchemaExact(db);
    }
    if (
        [...targetSet].some((name) => GLOBAL_RESET_GUARD_OBJECTS.has(name))
        || [...targetSet].some((name) => GLOBAL_RESET_FOUNDATION_OBJECTS.has(name))
    ) {
        await assertGlobalResetGuardsRuntimeSchemaExact(db);
    }
}

async function guardSchemaMutation(db, sql) {
    if (!containsSchemaMutation(sql) || !protectedObjectMentioned(sql)) return false;
    const targets = extractSchemaMutationTargets(sql);
    if (!targets.length) {
        throw new MigrationOwnedRuntimeSchemaError(
            'DDL runtime menciona schema migrado, mas o alvo nao pôde ser certificado.',
            'migration_owned_runtime_ddl_unparsed'
        );
    }
    const protectedTargets = targets.filter((name) => PROTECTED_OBJECTS.has(name));
    if (!protectedTargets.length) return false;
    const unprotectedTargets = targets.filter((name) => !PROTECTED_OBJECTS.has(name));
    if (unprotectedTargets.length) {
        throw new MigrationOwnedRuntimeSchemaError(
            'DDL runtime misto tentou alterar schema migrado junto de objetos nao protegidos.',
            'migration_owned_runtime_ddl_mixed',
            { protectedTargets, unprotectedTargets }
        );
    }

    await certifyProtectedTargets(db, protectedTargets);
    return true;
}

async function armMigrationOwnedRuntimeSchemaGuard(db, options = {}) {
    if (!db || typeof db.exec !== 'function') {
        throw new TypeError('DB invalido para migration-owned runtime schema guard.');
    }
    if (db[RUNTIME_SCHEMA_GUARD_SYMBOL]) return db[RUNTIME_SCHEMA_GUARD_SYMBOL];

    if (options.verifyOnArm !== false) {
        await assertCanonicalResetRuntimeSchemaExact(db);
    }

    const originalExec = db.exec.bind(db);
    const originalRun = typeof db.run === 'function' ? db.run.bind(db) : null;

    db.exec = async function guardedExec(sql, ...args) {
        if (await guardSchemaMutation(db, sql)) return db;
        return originalExec(sql, ...args);
    };

    if (originalRun) {
        db.run = async function guardedRun(sql, ...args) {
            if (await guardSchemaMutation(db, sql)) {
                return { changes: 0, lastID: undefined, guardedNoOp: true };
            }
            return originalRun(sql, ...args);
        };
    }

    const guard = Object.freeze({
        armed: true,
        protectedObjectCount: PROTECTED_OBJECTS.size,
    });
    Object.defineProperty(db, RUNTIME_SCHEMA_GUARD_SYMBOL, {
        value: guard,
        configurable: false,
        enumerable: false,
        writable: false,
    });
    return guard;
}

function migrationsContainRuntimeSchemaContract(migrations = []) {
    const versions = new Set((migrations || []).map((migration) => Number(migration?.version || 0)));
    return [30, 31, 32, 33].every((version) => versions.has(version));
}

module.exports = {
    MigrationOwnedRuntimeSchemaError,
    PROTECTED_OBJECTS,
    armMigrationOwnedRuntimeSchemaGuard,
    assertCanonicalResetRuntimeSchemaExact,
    assertCloverScriptRuntimeSchemaExact,
    assertGlobalResetGuardsRuntimeSchemaExact,
    assertResetJournalRuntimeSchemaExact,
    extractSchemaMutationTargets,
    migrationsContainRuntimeSchemaContract,
};
