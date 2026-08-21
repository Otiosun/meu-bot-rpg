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
    APPEARANCE_MODERATION_TARGETS,
    SITE_PROFILE_IMAGE_TARGETS,
    CHARACTER_TRAITS_TARGETS,
    ROLL_ATTEMPT_STATE_TARGETS,
    STORY_STATE_TARGETS,
    GAME_STATE_TARGETS,
    PLAYER_PATENT_TARGETS,
    SQUAD_COLUMNS_TARGETS,
    RAID_V1_BRIDGE_TARGETS,
    RAID_V2_COLUMNS_TARGETS,
    RAID_PARTICIPANT_FINALIZATION_TARGETS,
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
    Object.freeze({ version: 12, key: '0012_appearance_moderation_columns', targets: APPEARANCE_MODERATION_TARGETS }),
    Object.freeze({ version: 13, key: '0013_site_profile_image_columns', targets: SITE_PROFILE_IMAGE_TARGETS }),
    Object.freeze({ version: 14, key: '0014_character_trait_columns', targets: CHARACTER_TRAITS_TARGETS }),
    Object.freeze({ version: 15, key: '0015_roll_attempt_state_columns', targets: ROLL_ATTEMPT_STATE_TARGETS }),
    Object.freeze({ version: 16, key: '0016_story_state_columns', targets: STORY_STATE_TARGETS }),
    Object.freeze({ version: 17, key: '0017_game_state_columns', targets: GAME_STATE_TARGETS }),
    Object.freeze({ version: 18, key: '0018_player_patent_column', targets: PLAYER_PATENT_TARGETS }),
    Object.freeze({ version: 19, key: '0019_squad_columns', targets: SQUAD_COLUMNS_TARGETS }),
    Object.freeze({ version: 20, key: '0020_raid_v1_bridge', targets: RAID_V1_BRIDGE_TARGETS }),
    Object.freeze({ version: 21, key: '0021_raid_v2_columns', targets: RAID_V2_COLUMNS_TARGETS }),
    Object.freeze({ version: 22, key: '0022_raid_participant_finalization', targets: RAID_PARTICIPANT_FINALIZATION_TARGETS }),
]);

const EXPECTED_COVERAGE = Object.freeze({
    totalTargets: 156,
    basePresent: 56,
    baseMissing: 100,
    legacyEnsurePresent: 0,
});

const RAID_V2_RUNTIME_DEPENDENCIES = Object.freeze([
    Object.freeze({ kind: 'index', marker: 'idx_clover_raids_monthly_scope' }),
    Object.freeze({ kind: 'legacy_normalization', marker: "WHERE category_key IS NULL OR TRIM(category_key) = ''" }),
    Object.freeze({ kind: 'development_alias_normalization', marker: "WHERE category_key = 'missao_desenvolvimento'" }),
    Object.freeze({ kind: 'finalization_handoff', marker: 'ensureRaidFinalizationSchema(db)' }),
    Object.freeze({ kind: 'monthly_handoff', marker: 'ensureRaidMonthlyProgressSchema(db)' }),
]);

const RAID_FINALIZATION_RUNTIME_DEPENDENCIES = Object.freeze([
    Object.freeze({ source: 'schema', kind: 'raid_schema_handoff', marker: 'ensureCloverRaidSchema(db)' }),
    Object.freeze({ source: 'schema', kind: 'index', marker: 'idx_clover_raid_participant_finalization' }),
    Object.freeze({ source: 'schema', kind: 'reward_handoff', marker: 'ensureRaidRewardV2Schema(db)' }),
    Object.freeze({ source: 'schema', kind: 'pa_handoff', marker: 'ensurePaSchema(db)' }),
    Object.freeze({ source: 'schema', kind: 'stat_adjustment_handoff', marker: 'ensureCharacterStatAdjustmentSchema(db)' }),
    Object.freeze({ source: 'policy', kind: 'legacy_compatibility', marker: "'eligible_legacy'" }),
]);

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
    Object.freeze({ table: 'jogadores', columns: Object.freeze(['personagem_aparencia_normalizada']), kind: 'index', marker: 'idx_jogadores_aparencia_normalizada' }),
    Object.freeze({ table: 'jogadores', columns: Object.freeze(['ficha_status', 'historia_status']), kind: 'index', marker: 'idx_jogadores_historia_status' }),
    Object.freeze({ table: 'jogadores', columns: Object.freeze(['ficha_status', 'personagem_aparencia_status', 'historia_status', 'jogo_status']), kind: 'index', marker: 'idx_jogadores_jogo_status' }),
    Object.freeze({ table: 'clover_squads', columns: Object.freeze(['group_id']), kind: 'index', marker: 'idx_clover_squads_group' }),
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
function collectRuntimeEnsureColumnCalls(source) {
    const sourceText = String(source || '');
    const calls = [];
    const pattern = /ensureColumn\(\s*db\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(["'])(.*?)\3\s*\)/g;
    let match;
    while ((match = pattern.exec(sourceText)) !== null) {
        calls.push(Object.freeze({ table: match[1], column: match[2], definition: match[4] }));
    }
    return Object.freeze(calls);
}
function classifyRaidV2RuntimeEnsureCoverage(source) {
    const calls = collectRuntimeEnsureColumnCalls(source).filter((call) => call.table === 'clover_raids');
    const expectedByColumn = new Map(RAID_V2_COLUMNS_TARGETS.map((target) => [target.column, target]));
    const observedByColumn = new Map();
    for (const call of calls) {
        if (!observedByColumn.has(call.column)) observedByColumn.set(call.column, []);
        observedByColumn.get(call.column).push(call);
    }
    const missing = RAID_V2_COLUMNS_TARGETS.filter((target) => !observedByColumn.has(target.column)).map((target) => target.column);
    const unexpected = calls.filter((call) => !expectedByColumn.has(call.column)).map((call) => call.column);
    const duplicates = [...observedByColumn.entries()].filter(([, rows]) => rows.length !== 1).map(([column]) => column);
    const definitionMismatches = RAID_V2_COLUMNS_TARGETS.filter((target) => {
        const rows = observedByColumn.get(target.column) || [];
        return rows.length === 1 && rows[0].definition !== target.definition;
    }).map((target) => Object.freeze({
        column: target.column,
        expected: target.definition,
        observed: observedByColumn.get(target.column)[0].definition,
    }));
    return Object.freeze({
        expected: RAID_V2_COLUMNS_TARGETS.length,
        observed: calls.length,
        missing: Object.freeze(missing),
        unexpected: Object.freeze(unexpected),
        duplicates: Object.freeze(duplicates),
        definitionMismatches: Object.freeze(definitionMismatches),
    });
}
function validateRaidV2RuntimeDependencies(source) {
    const sourceText = String(source || '');
    return RAID_V2_RUNTIME_DEPENDENCIES.map((dependency) => Object.freeze({
        ...dependency,
        present: sourceText.includes(dependency.marker),
    }));
}
function classifyRaidFinalizationRuntimeEnsureCoverage(source) {
    const calls = collectRuntimeEnsureColumnCalls(source).filter((call) => call.table === 'clover_raid_participants');
    const expectedByColumn = new Map(RAID_PARTICIPANT_FINALIZATION_TARGETS.map((target) => [target.column, target]));
    const observedByColumn = new Map();
    for (const call of calls) {
        if (!observedByColumn.has(call.column)) observedByColumn.set(call.column, []);
        observedByColumn.get(call.column).push(call);
    }
    const missing = RAID_PARTICIPANT_FINALIZATION_TARGETS
        .filter((target) => !observedByColumn.has(target.column))
        .map((target) => target.column);
    const unexpected = calls
        .filter((call) => !expectedByColumn.has(call.column))
        .map((call) => call.column);
    const duplicates = [...observedByColumn.entries()]
        .filter(([, rows]) => rows.length !== 1)
        .map(([column]) => column);
    const definitionMismatches = RAID_PARTICIPANT_FINALIZATION_TARGETS
        .filter((target) => {
            const rows = observedByColumn.get(target.column) || [];
            return rows.length === 1 && rows[0].definition !== target.definition;
        })
        .map((target) => Object.freeze({
            column: target.column,
            expected: target.definition,
            observed: observedByColumn.get(target.column)[0].definition,
        }));
    return Object.freeze({
        expected: RAID_PARTICIPANT_FINALIZATION_TARGETS.length,
        observed: calls.length,
        missing: Object.freeze(missing),
        unexpected: Object.freeze(unexpected),
        duplicates: Object.freeze(duplicates),
        definitionMismatches: Object.freeze(definitionMismatches),
    });
}
function validateRaidFinalizationRuntimeDependencies(schemaSource, policySource) {
    const sources = {
        schema: String(schemaSource || ''),
        policy: String(policySource || ''),
    };
    return RAID_FINALIZATION_RUNTIME_DEPENDENCIES.map((dependency) => Object.freeze({
        ...dependency,
        present: sources[dependency.source].includes(dependency.marker),
    }));
}
function assertRaidFinalizationRuntimeRemovalPreconditions(
    schemaSource,
    policySource,
    prebootstrapKeys = []
) {
    const group = MIGRATED_COLUMN_GROUPS.find(
        (item) => item.version === 22 && item.key === '0022_raid_participant_finalization'
    );
    if (!group || group.targets.length !== 4) {
        const error = new Error('Cobertura formal da 0022 ausente ou divergente no auditor.');
        error.code = 'raid_finalization_migration_coverage_missing';
        throw error;
    }
    if (!Array.isArray(prebootstrapKeys) || !prebootstrapKeys.includes('0022_raid_participant_finalization')) {
        const error = new Error('Migration 0022 ainda não está promovida ao pre-bootstrap canônico.');
        error.code = 'raid_finalization_prebootstrap_missing';
        throw error;
    }
    const coverage = classifyRaidFinalizationRuntimeEnsureCoverage(schemaSource);
    if (
        coverage.expected !== 4
        || coverage.observed !== 4
        || coverage.missing.length
        || coverage.unexpected.length
        || coverage.duplicates.length
        || coverage.definitionMismatches.length
    ) {
        const error = new Error('Ensures runtime de finalização não espelham exatamente os 4 targets da migration 0022.');
        error.code = 'raid_finalization_runtime_coverage_mismatch';
        error.coverage = coverage;
        throw error;
    }
    const dependencies = validateRaidFinalizationRuntimeDependencies(schemaSource, policySource);
    const missingDependency = dependencies.find((item) => !item.present);
    if (missingDependency) {
        const error = new Error(`Dependência runtime de finalização ausente: ${missingDependency.marker}.`);
        error.code = 'raid_finalization_runtime_dependency_missing';
        error.marker = missingDependency.marker;
        error.source = missingDependency.source;
        throw error;
    }
    return Object.freeze({
        coverage,
        dependencies: Object.freeze(dependencies),
        prebootstrapPromoted: true,
        removalGate: 'passed_raid_finalization_prebootstrap',
    });
}
function assertRaidFinalizationRuntimeCleanupState(
    schemaSource,
    policySource,
    prebootstrapKeys = []
) {
    const group = MIGRATED_COLUMN_GROUPS.find(
        (item) => item.version === 22 && item.key === '0022_raid_participant_finalization'
    );
    if (!group || group.targets.length !== 4) {
        const error = new Error('Cobertura formal da 0022 ausente ou divergente no auditor pós-cleanup.');
        error.code = 'raid_finalization_migration_coverage_missing';
        throw error;
    }
    if (!Array.isArray(prebootstrapKeys) || !prebootstrapKeys.includes('0022_raid_participant_finalization')) {
        const error = new Error('Migration 0022 não está no pre-bootstrap canônico pós-cleanup.');
        error.code = 'raid_finalization_prebootstrap_missing';
        throw error;
    }

    const coverage = classifyRaidFinalizationRuntimeEnsureCoverage(schemaSource);
    const expectedMissing = RAID_PARTICIPANT_FINALIZATION_TARGETS.map((target) => target.column);
    const allCalls = collectRuntimeEnsureColumnCalls(schemaSource);
    const rewardCalls = allCalls.filter((call) => call.table === 'clover_raid_rewards');

    if (
        coverage.expected !== 4
        || coverage.observed !== 0
        || coverage.unexpected.length
        || coverage.duplicates.length
        || coverage.definitionMismatches.length
        || coverage.missing.length !== expectedMissing.length
        || coverage.missing.some((column, index) => column !== expectedMissing[index])
        || allCalls.length !== 0
        || rewardCalls.length !== 0
    ) {
        const error = new Error(
            'Estado pós-cleanup finalization divergente: participantes e Rewards devem ter zero ensures runtime.'
        );
        error.code = 'raid_finalization_runtime_cleanup_mismatch';
        error.coverage = coverage;
        error.allCalls = allCalls;
        error.rewardCalls = rewardCalls;
        throw error;
    }

    const sourceText = String(schemaSource || '');
    if (
        !sourceText.includes('async function ensureColumn(db, table, name, sql)')
        || !sourceText.includes('    ensureColumn,')
    ) {
        const error = new Error('Helper ensureColumn público foi removido indevidamente.');
        error.code = 'raid_reward_ensure_column_helper_missing';
        throw error;
    }

    const dependencies = validateRaidFinalizationRuntimeDependencies(schemaSource, policySource);
    const missingDependency = dependencies.find((item) => !item.present);
    if (missingDependency) {
        const error = new Error(`Dependência runtime de finalização ausente pós-cleanup: ${missingDependency.marker}.`);
        error.code = 'raid_finalization_runtime_dependency_missing';
        error.marker = missingDependency.marker;
        error.source = missingDependency.source;
        throw error;
    }

    return Object.freeze({
        coverage,
        dependencies: Object.freeze(dependencies),
        prebootstrapPromoted: true,
        remainingEnsureColumnCalls: allCalls,
        rewardResourceKeyEnsurePreserved: false,
        rewardResourceKeyEnsureRemoved: true,
        cleanupGate: 'passed_raid_finalization_runtime_cleanup',
    });
}
function assertRaidV2RuntimeCleanupState(runtimeSource, prebootstrapKeys = []) {
    const sourceText = String(runtimeSource || '');
    const group = MIGRATED_COLUMN_GROUPS.find((item) => item.version === 21 && item.key === '0021_raid_v2_columns');
    if (!group || group.targets.length !== 8) {
        const error = new Error('Cobertura formal da 0021 ausente ou divergente no auditor pós-cleanup.');
        error.code = 'raid_v2_migration_coverage_missing';
        throw error;
    }
    if (!Array.isArray(prebootstrapKeys) || !prebootstrapKeys.includes('0021_raid_v2_columns')) {
        const error = new Error('Migration 0021 não está no pre-bootstrap canônico pós-cleanup.');
        error.code = 'raid_v2_prebootstrap_missing';
        throw error;
    }
    const coverage = classifyRaidV2RuntimeEnsureCoverage(sourceText);
    const expectedMissing = RAID_V2_COLUMNS_TARGETS.map((target) => target.column);
    const ensureColumnTokenPresent = /\bensureColumn\b/.test(sourceText);
    if (
        coverage.expected !== 8
        || coverage.observed !== 0
        || coverage.unexpected.length
        || coverage.duplicates.length
        || coverage.definitionMismatches.length
        || coverage.missing.length !== expectedMissing.length
        || coverage.missing.some((column, index) => column !== expectedMissing[index])
        || ensureColumnTokenPresent
    ) {
        const error = new Error('Estado pós-cleanup V2 divergente: ensureColumn runtime deveria ser zero.');
        error.code = 'raid_v2_runtime_cleanup_mismatch';
        error.coverage = coverage;
        error.ensureColumnTokenPresent = ensureColumnTokenPresent;
        throw error;
    }
    const dependencies = validateRaidV2RuntimeDependencies(sourceText);
    const missingDependency = dependencies.find((item) => !item.present);
    if (missingDependency) {
        const error = new Error(`Dependência runtime V2 ausente pós-cleanup: ${missingDependency.marker}.`);
        error.code = 'raid_v2_runtime_dependency_missing';
        error.marker = missingDependency.marker;
        throw error;
    }
    return Object.freeze({
        coverage,
        dependencies: Object.freeze(dependencies),
        prebootstrapPromoted: true,
        ensureColumnTokenPresent: false,
        cleanupGate: 'passed_raid_v2_runtime_cleanup',
    });
}
function assertRaidV2RuntimeRemovalPreconditions(runtimeSource, prebootstrapKeys = []) {
    const group = MIGRATED_COLUMN_GROUPS.find((item) => item.version === 21 && item.key === '0021_raid_v2_columns');
    if (!group || group.targets.length !== 8) {
        const error = new Error('Cobertura formal da 0021 ausente ou divergente no auditor.');
        error.code = 'raid_v2_migration_coverage_missing';
        throw error;
    }
    if (!Array.isArray(prebootstrapKeys) || !prebootstrapKeys.includes('0021_raid_v2_columns')) {
        const error = new Error('Migration 0021 ainda não está promovida ao pre-bootstrap canônico.');
        error.code = 'raid_v2_prebootstrap_missing';
        throw error;
    }
    const coverage = classifyRaidV2RuntimeEnsureCoverage(runtimeSource);
    if (
        coverage.expected !== 8
        || coverage.observed !== 8
        || coverage.missing.length
        || coverage.unexpected.length
        || coverage.duplicates.length
        || coverage.definitionMismatches.length
    ) {
        const error = new Error('Ensures runtime V2 não espelham exatamente os 8 targets da migration 0021.');
        error.code = 'raid_v2_runtime_coverage_mismatch';
        error.coverage = coverage;
        throw error;
    }
    const dependencies = validateRaidV2RuntimeDependencies(runtimeSource);
    const missingDependency = dependencies.find((item) => !item.present);
    if (missingDependency) {
        const error = new Error(`Dependência runtime V2 ausente: ${missingDependency.marker}.`);
        error.code = 'raid_v2_runtime_dependency_missing';
        error.marker = missingDependency.marker;
        throw error;
    }
    return Object.freeze({
        coverage,
        dependencies: Object.freeze(dependencies),
        prebootstrapPromoted: true,
        removalGate: 'passed_raid_v2_prebootstrap',
    });
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
    EXPECTED_COVERAGE, MIGRATED_COLUMN_GROUPS, POST_SCHEMA_DEPENDENCIES, RAID_V2_RUNTIME_DEPENDENCIES,
    RAID_FINALIZATION_RUNTIME_DEPENDENCIES,
    assertConsolidationPreconditions, assertRaidV2RuntimeCleanupState, assertRaidV2RuntimeRemovalPreconditions,
    assertRaidFinalizationRuntimeRemovalPreconditions, assertRaidFinalizationRuntimeCleanupState,
    classifyLegacySchemaCoverage, classifyRaidV2RuntimeEnsureCoverage,
    classifyRaidFinalizationRuntimeEnsureCoverage, collectMigratedColumnTargets,
    collectRuntimeEnsureColumnCalls, createBodyHasColumn, findCreateTableBody, legacyEnsureMarker,
    validatePostSchemaDependencies, validateRaidV2RuntimeDependencies,
    validateRaidFinalizationRuntimeDependencies,
};
