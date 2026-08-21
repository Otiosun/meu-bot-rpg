'use strict';

const {
    RAID_REWARDS_V2_INDEX,
    RAID_REWARDS_V2_KEY,
    RAID_REWARDS_V2_MIGRATION,
    RAID_REWARDS_V2_TABLE_SQL,
} = require('./schemaMigrationCatalog');

const CLEAN_RUNTIME_FUNCTION = `async function ensureRaidRewardV2Schema(db) {
    await ensureCloverRaidSchema(db);
}`;

function normalizeSql(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/;$/, '')
        .trim();
}

function normalizeFunction(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseCommaList(value) {
    return String(value || '')
        .split(',')
        .map((item) => item.trim().replace(/\s+/g, ' '))
        .filter(Boolean);
}

function findFunctionRange(source, name, nextName) {
    const text = String(source || '');
    const startMarker = `async function ${name}(db) {`;
    const start = text.indexOf(startMarker);
    if (start < 0) return null;

    const nextMarker = nextName ? `\nasync function ${nextName}(db) {` : '\nmodule.exports =';
    const next = text.indexOf(nextMarker, start + startMarker.length);
    if (next < 0) return null;

    const end = text.lastIndexOf('\n}', next);
    if (end < start) return null;
    return Object.freeze({
        start,
        end: end + 2,
        source: text.slice(start, end + 2),
    });
}

function runtimeRewardFunctionSource(runtimeSource) {
    return findFunctionRange(
        runtimeSource,
        'ensureRaidRewardV2Schema',
        'ensureRaidFinalizationSchema'
    )?.source || '';
}

function extractCreateTableSql(source) {
    const match = String(source || '').match(
        /CREATE TABLE clover_raid_rewards\s*\(([\s\S]*?)\);\s*INSERT INTO clover_raid_rewards/
    );
    if (!match) return null;
    return `CREATE TABLE clover_raid_rewards (${match[1]})`;
}

function extractIndexColumns(source) {
    const match = String(source || '').match(
        /CREATE INDEX(?: IF NOT EXISTS)? idx_clover_raid_rewards_raid\s+ON clover_raid_rewards\s*\(([^)]+)\)/
    );
    return match ? parseCommaList(match[1]) : [];
}

function extractCopyProjection(source) {
    const match = String(source || '').match(
        /INSERT INTO clover_raid_rewards\s*\(([\s\S]*?)\)\s*SELECT\s*([\s\S]*?)\s*FROM clover_raid_rewards_legacy_v1/
    );
    if (!match) {
        return Object.freeze({ target: Object.freeze([]), select: Object.freeze([]) });
    }
    return Object.freeze({
        target: Object.freeze(parseCommaList(match[1])),
        select: Object.freeze(parseCommaList(match[2])),
    });
}

function compareProjection(left, right) {
    return left.target.length === right.target.length
        && left.select.length === right.select.length
        && left.target.every((value, index) => value === right.target[index])
        && left.select.every((value, index) => value === right.select[index]);
}

function inspectRuntimeDependencies(runtimeSource) {
    const text = String(runtimeSource || '');
    const fn = runtimeRewardFunctionSource(text);
    return Object.freeze([
        Object.freeze({
            marker: 'ensureRaidRewardV2Schema_function',
            present: Boolean(fn),
        }),
        Object.freeze({
            marker: 'ensureCloverRaidSchema_handoff',
            present: fn.includes('await ensureCloverRaidSchema(db);'),
        }),
        Object.freeze({
            marker: 'ensureRaidFinalizationSchema_handoff',
            present: text.includes('await ensureRaidRewardV2Schema(db);'),
        }),
        Object.freeze({
            marker: 'ensureRaidRewardV2Schema_export',
            present: /module\.exports\s*=\s*\{[\s\S]*\bensureRaidRewardV2Schema\b[\s\S]*\};/.test(text),
        }),
    ]);
}

function analyzeRaidRewardsV2RuntimeCoverage(runtimeSource, prebootstrapKeys = []) {
    const text = String(runtimeSource || '');
    const fn = runtimeRewardFunctionSource(text);
    const formalMigrationSource = String(RAID_REWARDS_V2_MIGRATION.up);

    const runtimeTableSql = extractCreateTableSql(fn);
    const formalTableSql = RAID_REWARDS_V2_TABLE_SQL;
    const runtimeIndexColumns = extractIndexColumns(fn);
    const formalIndexColumns = Array.from(RAID_REWARDS_V2_INDEX.columns);
    const runtimeProjection = extractCopyProjection(fn);
    const formalProjection = extractCopyProjection(formalMigrationSource);

    const resourceKeyEnsureExpected =
        "await ensureColumn(db, 'clover_raid_rewards', 'resource_key', 'TEXT DEFAULT NULL');";
    const dependencies = inspectRuntimeDependencies(text);
    const formalSafety = Object.freeze([
        Object.freeze({
            marker: 'sqlite_sequence_preservation',
            present: formalMigrationSource.includes('sqlite_sequence'),
        }),
        Object.freeze({
            marker: 'dependency_fail_closed',
            present: formalMigrationSource.includes('raid_rewards_v2_dependency_mapping_required'),
        }),
        Object.freeze({
            marker: 'shape_fail_closed',
            present: formalMigrationSource.includes('raid_rewards_v2_schema_mapping_required'),
        }),
        Object.freeze({
            marker: 'ordered_copy',
            present: formalMigrationSource.includes('ORDER BY id'),
        }),
    ]);

    return Object.freeze({
        migrationKey: RAID_REWARDS_V2_KEY,
        prebootstrapPromoted: Array.isArray(prebootstrapKeys)
            && prebootstrapKeys.includes(RAID_REWARDS_V2_KEY),
        runtimeFunctionPresent: Boolean(fn),
        tableShapeMatch: Boolean(runtimeTableSql)
            && normalizeSql(runtimeTableSql) === normalizeSql(formalTableSql),
        runtimeTableSql: normalizeSql(runtimeTableSql),
        formalTableSql: normalizeSql(formalTableSql),
        indexMatch: runtimeIndexColumns.length === formalIndexColumns.length
            && runtimeIndexColumns.every((value, index) => value === formalIndexColumns[index]),
        runtimeIndexColumns: Object.freeze(runtimeIndexColumns),
        formalIndexColumns: Object.freeze(formalIndexColumns),
        copyProjectionMatch: compareProjection(runtimeProjection, formalProjection),
        runtimeProjection,
        formalProjection,
        resourceKeyEnsureMatch: fn.includes(resourceKeyEnsureExpected),
        resourceKeyEnsureExpected,
        dependencies,
        formalSafety,
        runtimeMigrationMarkersPresent: Object.freeze({
            savepoint: fn.includes('SAVEPOINT migrate_clover_raid_rewards_v2'),
            legacyRename: fn.includes('RENAME TO clover_raid_rewards_legacy_v1'),
            createTable: Boolean(runtimeTableSql),
            copyRows: runtimeProjection.target.length > 0,
            canonicalIndex: runtimeIndexColumns.length > 0,
        }),
    });
}

function assertRaidRewardsV2RuntimeRemovalPreconditions(runtimeSource, prebootstrapKeys = []) {
    const analysis = analyzeRaidRewardsV2RuntimeCoverage(runtimeSource, prebootstrapKeys);
    if (!analysis.prebootstrapPromoted) {
        const error = new Error('0023 Raid Rewards V2 nao esta no pre-bootstrap canonico.');
        error.code = 'raid_rewards_v2_prebootstrap_missing';
        throw error;
    }
    if (!analysis.runtimeFunctionPresent || !analysis.tableShapeMatch) {
        const error = new Error('CREATE TABLE runtime de Rewards V2 diverge do shape formal 0023.');
        error.code = 'raid_rewards_v2_runtime_shape_mismatch';
        error.analysis = analysis;
        throw error;
    }
    if (!analysis.indexMatch) {
        const error = new Error('Indice runtime de Rewards V2 diverge do indice formal 0023.');
        error.code = 'raid_rewards_v2_runtime_index_mismatch';
        error.analysis = analysis;
        throw error;
    }
    if (!analysis.copyProjectionMatch) {
        const error = new Error('Projecao V1->V2 runtime diverge da migration formal 0023.');
        error.code = 'raid_rewards_v2_runtime_copy_mismatch';
        error.analysis = analysis;
        throw error;
    }
    if (!analysis.resourceKeyEnsureMatch) {
        const error = new Error('Ensure runtime de resource_key diverge do contrato formal V2.');
        error.code = 'raid_rewards_v2_runtime_resource_key_mismatch';
        error.analysis = analysis;
        throw error;
    }
    const missingDependency = analysis.dependencies.find((item) => !item.present);
    if (missingDependency) {
        const error = new Error(`Dependencia runtime Rewards ausente: ${missingDependency.marker}.`);
        error.code = 'raid_rewards_v2_runtime_dependency_missing';
        error.marker = missingDependency.marker;
        throw error;
    }
    const missingFormalSafety = analysis.formalSafety.find((item) => !item.present);
    if (missingFormalSafety) {
        const error = new Error(`Garantia formal 0023 ausente: ${missingFormalSafety.marker}.`);
        error.code = 'raid_rewards_v2_formal_safety_missing';
        error.marker = missingFormalSafety.marker;
        throw error;
    }
    if (Object.values(analysis.runtimeMigrationMarkersPresent).some((value) => value !== true)) {
        const error = new Error('DDL runtime de Rewards V2 ja nao esta integralmente presente no slice de coverage.');
        error.code = 'raid_rewards_v2_runtime_precleanup_state_mismatch';
        error.analysis = analysis;
        throw error;
    }

    return Object.freeze({
        ...analysis,
        removalGate: 'passed_raid_rewards_v2_prebootstrap',
    });
}

function makeSyntheticCleanRuntimeSource(runtimeSource) {
    const text = String(runtimeSource || '');
    const range = findFunctionRange(
        text,
        'ensureRaidRewardV2Schema',
        'ensureRaidFinalizationSchema'
    );
    if (!range) {
        const error = new Error('ensureRaidRewardV2Schema ausente para sintetizar cleanup.');
        error.code = 'raid_rewards_v2_runtime_dependency_missing';
        error.marker = 'ensureRaidRewardV2Schema_function';
        throw error;
    }
    return text.slice(0, range.start) + CLEAN_RUNTIME_FUNCTION + text.slice(range.end);
}

function assertRaidRewardsV2RuntimeCleanupState(runtimeSource, prebootstrapKeys = []) {
    const text = String(runtimeSource || '');
    if (!Array.isArray(prebootstrapKeys) || !prebootstrapKeys.includes(RAID_REWARDS_V2_KEY)) {
        const error = new Error('0023 Raid Rewards V2 nao esta no pre-bootstrap canonico pos-cleanup.');
        error.code = 'raid_rewards_v2_prebootstrap_missing';
        throw error;
    }

    const fn = runtimeRewardFunctionSource(text);
    if (normalizeFunction(fn) !== normalizeFunction(CLEAN_RUNTIME_FUNCTION)) {
        const error = new Error(
            'Estado pos-cleanup Rewards divergente: wrapper deve manter somente ensureCloverRaidSchema(db).'
        );
        error.code = 'raid_rewards_v2_runtime_cleanup_mismatch';
        error.runtimeFunction = fn;
        throw error;
    }

    const dependencies = inspectRuntimeDependencies(text);
    const missingDependency = dependencies.find((item) => !item.present);
    if (missingDependency) {
        const error = new Error(`Dependencia runtime Rewards ausente pos-cleanup: ${missingDependency.marker}.`);
        error.code = 'raid_rewards_v2_runtime_dependency_missing';
        error.marker = missingDependency.marker;
        throw error;
    }

    const forbidden = [
        'SAVEPOINT migrate_clover_raid_rewards_v2',
        'clover_raid_rewards_legacy_v1',
        'CREATE TABLE clover_raid_rewards',
        'INSERT INTO clover_raid_rewards',
        'idx_clover_raid_rewards_raid',
        "ensureColumn(db, 'clover_raid_rewards'",
    ];
    const presentForbidden = forbidden.filter((marker) => fn.includes(marker));
    if (presentForbidden.length) {
        const error = new Error('DDL/ensure Rewards reintroduzido apos cleanup.');
        error.code = 'raid_rewards_v2_runtime_cleanup_mismatch';
        error.presentForbidden = presentForbidden;
        throw error;
    }

    return Object.freeze({
        prebootstrapPromoted: true,
        dependencies,
        cleanupGate: 'passed_raid_rewards_v2_runtime_cleanup',
    });
}

module.exports = {
    CLEAN_RUNTIME_FUNCTION,
    analyzeRaidRewardsV2RuntimeCoverage,
    assertRaidRewardsV2RuntimeCleanupState,
    assertRaidRewardsV2RuntimeRemovalPreconditions,
    makeSyntheticCleanRuntimeSource,
};
