'use strict';

const {
    LOW_RISK_COLUMN_TARGETS,
    BOOTSTRAP_METADATA_TARGETS,
} = require('./schemaMigrationService');
const {
    MARKET_REQUEST_TARGETS,
    QUICK_EVALUATION_TARGETS,
    PLAYER_ROLLS_TARGETS,
    ITEM_TEMPLATES_TARGETS,
    INVENTORY_ITEMS_TARGETS,
    ADMIN_SERVICE_TARGETS,
    PLAYER_PROFILE_TARGETS,
    CHARACTER_IDENTITY_TARGETS,
} = require('./schemaMigrationCatalog');

const MIGRATED_COLUMN_GROUPS = Object.freeze([
    Object.freeze({ version: 2, key: '0002_low_risk_legacy_columns', targets: LOW_RISK_COLUMN_TARGETS }),
    Object.freeze({ version: 3, key: '0003_bootstrap_metadata_columns', targets: BOOTSTRAP_METADATA_TARGETS }),
    Object.freeze({ version: 4, key: '0004_market_request_columns', targets: MARKET_REQUEST_TARGETS }),
    Object.freeze({ version: 5, key: '0005_quick_evaluation_columns', targets: QUICK_EVALUATION_TARGETS }),
    Object.freeze({ version: 6, key: '0006_player_roll_columns', targets: PLAYER_ROLLS_TARGETS }),
    Object.freeze({ version: 7, key: '0007_item_template_columns', targets: ITEM_TEMPLATES_TARGETS }),
    Object.freeze({ version: 8, key: '0008_inventory_item_columns', targets: INVENTORY_ITEMS_TARGETS }),
    Object.freeze({ version: 9, key: '0009_admin_service_columns', targets: ADMIN_SERVICE_TARGETS }),
    Object.freeze({ version: 10, key: '0010_player_profile_columns', targets: PLAYER_PROFILE_TARGETS }),
    Object.freeze({ version: 11, key: '0011_character_identity_columns', targets: CHARACTER_IDENTITY_TARGETS }),
]);

const EXPECTED_COVERAGE = Object.freeze({
    totalTargets: 79,
    basePresent: 28,
    baseMissing: 51,
    legacyEnsurePresent: 0,
});

const POST_SCHEMA_DEPENDENCIES = Object.freeze([
    Object.freeze({ table: 'clover_market_listings', columns: Object.freeze(['idempotency_key']), kind: 'index', marker: 'idx_clover_market_listings_idempotency' }),
    Object.freeze({ table: 'clover_quick_evaluations', columns: Object.freeze(['scene_sent_at', 'scene_source']), kind: 'index', marker: 'idx_clover_quick_evaluations_scene' }),
    Object.freeze({ table: 'clover_quick_evaluations', columns: Object.freeze(['quoted_message_key']), kind: 'index', marker: 'idx_clover_quick_evaluations_quoted_message' }),
    Object.freeze({ table: 'clover_quick_evaluations', columns: Object.freeze(['scene_sent_at']), kind: 'data_normalization', marker: 'normalizeQuickEvaluationWeekKeys' }),
    Object.freeze({ table: 'clover_item_templates', columns: Object.freeze(['requestable']), kind: 'index', marker: 'idx_clover_item_templates_requestable' }),
    Object.freeze({ table: 'clover_inventory_items', columns: Object.freeze(['template_key', 'status']), kind: 'index', marker: 'idx_clover_inventory_template_status' }),
    Object.freeze({ table: 'clover_inventory_items', columns: Object.freeze(['equipped_slot']), kind: 'index', marker: 'idx_clover_inventory_equipped_slot' }),
    Object.freeze({ table: 'clover_inventory_items', columns: Object.freeze(['category', 'origin', 'status', 'quality', 'base_price', 'reference_price']), kind: 'data_normalization', marker: 'UPDATE clover_inventory_items' }),
    Object.freeze({ table: 'clover_admin_service_entries', columns: Object.freeze(['evaluation_id']), kind: 'index', marker: 'idx_clover_admin_service_evaluation' }),
    Object.freeze({ table: 'clover_admin_service_entries', columns: Object.freeze(['evaluator_id', 'status']), kind: 'index', marker: 'idx_clover_admin_service_evaluator_status' }),
    Object.freeze({ table: 'clover_admin_service_entries', columns: Object.freeze(['service_week_key']), kind: 'index', marker: 'idx_clover_admin_service_week' }),
]);

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function collectMigratedColumnTargets() {
    return MIGRATED_COLUMN_GROUPS.flatMap((group) => group.targets.map((target) => Object.freeze({
        version: group.version, migrationKey: group.key, table: target.table, column: target.column, definition: target.definition,
    })));
}
function findCreateTableBody(source, tableName) {
    const sourceText = String(source || '');
    const needle = `CREATE TABLE IF NOT EXISTS ${tableName} (`;
    const start = sourceText.indexOf(needle);
    if (start < 0) return null;
    const bodyStart = start + needle.length;
    const terminators = ['\n        )\n    `);','\n    )\n    `);','\n        )\r\n    `);','\n    )\r\n    `);'];
    let end = -1;
    for (const terminator of terminators) {
        const candidate = sourceText.indexOf(terminator, bodyStart);
        if (candidate >= 0 && (end < 0 || candidate < end)) end = candidate;
    }
    if (end < 0) return null;
    return sourceText.slice(bodyStart, end);
}
function createBodyHasColumn(body, columnName) {
    if (!body) return false;
    const column = escapeRegExp(columnName);
    return new RegExp(`^\\s*${column}\\s+`, 'mi').test(body);
}
function legacyEnsureMarker(table, column) { return `ensureColumn(db, '${table}', '${column}'`; }
function classifyLegacySchemaCoverage(source) {
    const sourceText = String(source || '');
    const targets = collectMigratedColumnTargets();
    const tableBodies = new Map();
    const rows = targets.map((target) => {
        if (!tableBodies.has(target.table)) tableBodies.set(target.table, findCreateTableBody(sourceText, target.table));
        const basePresent = createBodyHasColumn(tableBodies.get(target.table), target.column);
        const ensureMarker = legacyEnsureMarker(target.table, target.column);
        const legacyEnsurePresent = sourceText.includes(ensureMarker);
        return Object.freeze({ ...target, basePresent, legacyEnsurePresent, ensureMarker });
    });
    return Object.freeze({
        totalTargets: rows.length,
        basePresent: rows.filter((row) => row.basePresent).length,
        baseMissing: rows.filter((row) => !row.basePresent).length,
        legacyEnsurePresent: rows.filter((row) => row.legacyEnsurePresent).length,
        rows: Object.freeze(rows),
    });
}
function validatePostSchemaDependencies(source) {
    const sourceText = String(source || '');
    return POST_SCHEMA_DEPENDENCIES.map((dependency) => Object.freeze({ ...dependency, present: sourceText.includes(dependency.marker) }));
}
function assertConsolidationPreconditions(source) {
    const coverage = classifyLegacySchemaCoverage(source);
    for (const [key, expected] of Object.entries(EXPECTED_COVERAGE)) {
        if (coverage[key] !== expected) {
            const error = new Error(`Cobertura de schema-base divergente em ${key}: esperado ${expected}, observado ${coverage[key]}.`);
            error.code = 'schema_base_coverage_mismatch'; error.metric = key; error.expected = expected; error.observed = coverage[key]; throw error;
        }
    }
    const dependencies = validatePostSchemaDependencies(source);
    const missingDependency = dependencies.find((item) => !item.present);
    if (missingDependency) {
        const error = new Error(`Dependência pós-DDL ausente: ${missingDependency.marker}.`);
        error.code = 'schema_base_dependency_missing'; error.marker = missingDependency.marker; throw error;
    }
    return Object.freeze({
        coverage,
        dependencies: Object.freeze(dependencies),
        requiresLegacyRepairBeforeBaseline: false,
        removalGate: 'passed_canonical_prebootstrap',
    });
}
module.exports = {
    EXPECTED_COVERAGE, MIGRATED_COLUMN_GROUPS, POST_SCHEMA_DEPENDENCIES, assertConsolidationPreconditions,
    classifyLegacySchemaCoverage, collectMigratedColumnTargets, createBodyHasColumn, findCreateTableBody,
    legacyEnsureMarker, validatePostSchemaDependencies,
};
