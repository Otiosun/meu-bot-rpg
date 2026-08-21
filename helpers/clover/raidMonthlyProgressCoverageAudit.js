'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
    RAID_MONTHLY_LEDGER_TABLE_SQL,
    RAID_MONTHLY_PROGRESS_INDEXES,
    RAID_MONTHLY_PROGRESS_KEY,
    RAID_MONTHLY_PROGRESS_MIGRATION,
    RAID_MONTHLY_RESERVATIONS_TABLE_SQL,
} = require('./schemaMigrationCatalog');

const CLEAN_RUNTIME_FUNCTION = `async function ensureRaidMonthlyProgressSchema(db) {
    void db;
}`;

function normalizeSql(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .replace(/CREATE TABLE IF NOT EXISTS/gi, 'CREATE TABLE')
        .replace(/CREATE INDEX IF NOT EXISTS/gi, 'CREATE INDEX')
        .trim()
        .replace(/;$/, '')
        .trim();
}

function normalizeFunction(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function findFunctionRange(source) {
    const text = String(source || '');
    const startMarker = 'async function ensureRaidMonthlyProgressSchema(db) {';
    const start = text.indexOf(startMarker);
    if (start < 0) return null;
    const next = text.indexOf('\nfunction validateScope(', start + startMarker.length);
    if (next < 0) return null;
    const end = text.lastIndexOf('\n}', next);
    if (end < start) return null;
    return Object.freeze({ start, end: end + 2, source: text.slice(start, end + 2) });
}

function runtimeMonthlyFunctionSource(runtimeSource) {
    return findFunctionRange(runtimeSource)?.source || '';
}

function extractExecSql(functionSource) {
    const values = [];
    const regex = /await\s+db\.exec\(\s*`([\s\S]*?)`\s*\);/g;
    let match;
    while ((match = regex.exec(String(functionSource || ''))) !== null) {
        values.push(match[1].trim());
    }
    return values;
}

function runtimeOperationalCallsiteCount(runtimeSource) {
    const text = String(runtimeSource || '');
    const range = findFunctionRange(text);
    const outside = range
        ? text.slice(0, range.start) + text.slice(range.end)
        : text;
    return (outside.match(/await\s+ensureRaidMonthlyProgressSchema\(db\);/g) || []).length;
}

function exported(runtimeSource) {
    return /module\.exports\s*=\s*\{[\s\S]*\bensureRaidMonthlyProgressSchema\b[\s\S]*\};/.test(
        String(runtimeSource || '')
    );
}

function formalSafetyAnalysis() {
    const upSource = String(RAID_MONTHLY_PROGRESS_MIGRATION.up);
    const catalogSource = fs.readFileSync(
        path.join(__dirname, 'schemaMigrationCatalog.js'),
        'utf8'
    );
    const storedStateGatePresent =
        upSource.includes('await assertRaidMonthlyStoredStateCompatible(db);')
        && catalogSource.includes("error.code = 'raid_monthly_state_mapping_required';");
    const markers = Object.freeze([
        Object.freeze({ marker: 'schema_fail_closed', present: upSource.includes('raid_monthly_schema_mapping_required') }),
        Object.freeze({ marker: 'index_fail_closed', present: upSource.includes('raid_monthly_index_mapping_required') }),
        Object.freeze({ marker: 'stored_state_fail_closed', present: storedStateGatePresent }),
        Object.freeze({ marker: 'non_retroactive_invariant', present: upSource.includes('raid_monthly_non_retroactive_invariant_failed') }),
        Object.freeze({
            marker: 'no_historical_raid_reads',
            present: !/FROM\s+clover_raids\b|FROM\s+clover_raid_participants\b/i.test(upSource),
        }),
    ]);
    return markers;
}

function analyzeRaidMonthlyProgressRuntimeCoverage(runtimeSource, prebootstrapKeys = []) {
    const text = String(runtimeSource || '');
    const fn = runtimeMonthlyFunctionSource(text);
    const execSql = extractExecSql(fn);
    const runtimeTables = execSql.filter((sql) => /^CREATE\s+TABLE\b/i.test(sql));
    const runtimeIndexes = execSql.filter((sql) => /^CREATE\s+INDEX\b/i.test(sql));
    const formalTables = [RAID_MONTHLY_RESERVATIONS_TABLE_SQL, RAID_MONTHLY_LEDGER_TABLE_SQL];
    const formalIndexes = RAID_MONTHLY_PROGRESS_INDEXES.map((entry) => entry.sql);

    const tableMatches = formalTables.map((formalSql) => {
        const normalized = normalizeSql(formalSql);
        return Object.freeze({
            formalSql: normalized,
            matched: runtimeTables.some((runtimeSql) => normalizeSql(runtimeSql) === normalized),
        });
    });
    const indexMatches = formalIndexes.map((formalSql) => {
        const normalized = normalizeSql(formalSql);
        return Object.freeze({
            formalSql: normalized,
            matched: runtimeIndexes.some((runtimeSql) => normalizeSql(runtimeSql) === normalized),
        });
    });

    return Object.freeze({
        migrationKey: RAID_MONTHLY_PROGRESS_KEY,
        prebootstrapPromoted: Array.isArray(prebootstrapKeys)
            && prebootstrapKeys.includes(RAID_MONTHLY_PROGRESS_KEY),
        runtimeFunctionPresent: Boolean(fn),
        runtimeExecCount: execSql.length,
        runtimeTableCount: runtimeTables.length,
        runtimeIndexCount: runtimeIndexes.length,
        tableMatches: Object.freeze(tableMatches),
        indexMatches: Object.freeze(indexMatches),
        tablesMatch: tableMatches.length === 2 && tableMatches.every((entry) => entry.matched),
        indexesMatch: indexMatches.length === 4 && indexMatches.every((entry) => entry.matched),
        exported: exported(text),
        operationalCallsiteCount: runtimeOperationalCallsiteCount(text),
        formalSafety: formalSafetyAnalysis(),
    });
}

function assertRaidMonthlyProgressRuntimeRemovalPreconditions(runtimeSource, prebootstrapKeys = []) {
    const analysis = analyzeRaidMonthlyProgressRuntimeCoverage(runtimeSource, prebootstrapKeys);
    if (!analysis.prebootstrapPromoted) {
        const error = new Error('0024 Monthly nao esta no pre-bootstrap canonico.');
        error.code = 'raid_monthly_prebootstrap_missing';
        throw error;
    }
    if (!analysis.runtimeFunctionPresent) {
        const error = new Error('ensureRaidMonthlyProgressSchema ausente.');
        error.code = 'raid_monthly_runtime_dependency_missing';
        error.marker = 'ensureRaidMonthlyProgressSchema_function';
        throw error;
    }
    if (analysis.runtimeExecCount !== 6 || analysis.runtimeTableCount !== 2 || analysis.runtimeIndexCount !== 4) {
        const error = new Error('DDL runtime Monthly pre-cleanup nao possui exatamente 2 tabelas + 4 indices.');
        error.code = 'raid_monthly_runtime_precleanup_state_mismatch';
        error.analysis = analysis;
        throw error;
    }
    if (!analysis.tablesMatch) {
        const error = new Error('CREATE TABLE runtime Monthly diverge do formal 0024.');
        error.code = 'raid_monthly_runtime_shape_mismatch';
        error.analysis = analysis;
        throw error;
    }
    if (!analysis.indexesMatch) {
        const error = new Error('CREATE INDEX runtime Monthly diverge do formal 0024.');
        error.code = 'raid_monthly_runtime_index_mismatch';
        error.analysis = analysis;
        throw error;
    }
    if (!analysis.exported) {
        const error = new Error('Export ensureRaidMonthlyProgressSchema ausente.');
        error.code = 'raid_monthly_runtime_dependency_missing';
        error.marker = 'ensureRaidMonthlyProgressSchema_export';
        throw error;
    }
    if (analysis.operationalCallsiteCount < 2) {
        const error = new Error('Callsites operacionais Monthly inesperadamente ausentes.');
        error.code = 'raid_monthly_runtime_dependency_missing';
        error.marker = 'monthly_operational_callsites';
        throw error;
    }
    const missingSafety = analysis.formalSafety.find((entry) => !entry.present);
    if (missingSafety) {
        const error = new Error(`Garantia formal Monthly ausente: ${missingSafety.marker}.`);
        error.code = 'raid_monthly_formal_safety_missing';
        error.marker = missingSafety.marker;
        throw error;
    }
    return Object.freeze({ ...analysis, removalGate: 'passed_raid_monthly_0024_prebootstrap' });
}

function makeSyntheticCleanRuntimeSource(runtimeSource) {
    const text = String(runtimeSource || '');
    const range = findFunctionRange(text);
    if (!range) {
        const error = new Error('ensureRaidMonthlyProgressSchema ausente para sintetizar cleanup.');
        error.code = 'raid_monthly_runtime_dependency_missing';
        throw error;
    }
    return text.slice(0, range.start) + CLEAN_RUNTIME_FUNCTION + text.slice(range.end);
}

function assertRaidMonthlyProgressRuntimeCleanupState(runtimeSource, prebootstrapKeys = []) {
    const text = String(runtimeSource || '');
    if (!Array.isArray(prebootstrapKeys) || !prebootstrapKeys.includes(RAID_MONTHLY_PROGRESS_KEY)) {
        const error = new Error('0024 Monthly nao esta no pre-bootstrap canonico pos-cleanup.');
        error.code = 'raid_monthly_prebootstrap_missing';
        throw error;
    }
    const fn = runtimeMonthlyFunctionSource(text);
    if (normalizeFunction(fn) !== normalizeFunction(CLEAN_RUNTIME_FUNCTION)) {
        const error = new Error('Wrapper Monthly pos-cleanup deve ser no-op e preservar a API.');
        error.code = 'raid_monthly_runtime_cleanup_mismatch';
        error.runtimeFunction = fn;
        throw error;
    }
    if (!exported(text)) {
        const error = new Error('Export Monthly ausente pos-cleanup.');
        error.code = 'raid_monthly_runtime_dependency_missing';
        error.marker = 'ensureRaidMonthlyProgressSchema_export';
        throw error;
    }
    const callsites = runtimeOperationalCallsiteCount(text);
    if (callsites < 2) {
        const error = new Error('Callsites Monthly foram removidos junto com DDL.');
        error.code = 'raid_monthly_runtime_dependency_missing';
        error.marker = 'monthly_operational_callsites';
        throw error;
    }
    const forbidden = [
        'CREATE TABLE',
        'CREATE INDEX',
        'clover_raid_monthly_reservations',
        'clover_raid_monthly_ledger',
        'db.exec(',
    ];
    const presentForbidden = forbidden.filter((marker) => fn.includes(marker));
    if (presentForbidden.length) {
        const error = new Error('DDL Monthly reintroduzido apos cleanup.');
        error.code = 'raid_monthly_runtime_cleanup_mismatch';
        error.markers = presentForbidden;
        throw error;
    }
    return Object.freeze({
        migrationKey: RAID_MONTHLY_PROGRESS_KEY,
        cleanupGate: 'passed_no_runtime_monthly_ddl',
        exported: true,
        operationalCallsiteCount: callsites,
        runtimeFunction: fn,
    });
}

module.exports = {
    CLEAN_RUNTIME_FUNCTION,
    analyzeRaidMonthlyProgressRuntimeCoverage,
    assertRaidMonthlyProgressRuntimeCleanupState,
    assertRaidMonthlyProgressRuntimeRemovalPreconditions,
    makeSyntheticCleanRuntimeSource,
    runtimeMonthlyFunctionSource,
    runtimeOperationalCallsiteCount,
};
