'use strict';

const {
    RAID_SUPPORT_INDEXES,
    RAID_SUPPORT_TABLES,
    RAID_SUPPORT_TABLES_KEY,
    RAID_SUPPORT_TABLES_MIGRATION,
} = require('./schemaMigrationCatalog');

const RAID_FUNCTION_START = 'async function ensureCloverRaidSchema(db) {';
const RAID_FUNCTION_NEXT = '\nasync function ensureCloverSquadSchema(db) {';

function normalizeSql(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .replace(/\bCREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/gi, 'CREATE TABLE')
        .replace(/\bCREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/gi, (_match, unique) => (
            `CREATE ${unique || ''}INDEX`
        ))
        .trim()
        .replace(/;$/, '')
        .trim();
}

function legacyRaidFunctionRange(source) {
    const text = String(source || '');
    const start = text.indexOf(RAID_FUNCTION_START);
    if (start < 0) return null;
    const end = text.indexOf(RAID_FUNCTION_NEXT, start + RAID_FUNCTION_START.length);
    if (end < 0) return null;
    return Object.freeze({
        start,
        end,
        source: text.slice(start, end),
    });
}

function extractExecBlocks(functionSource) {
    const text = String(functionSource || '');
    const blocks = [];
    const regex = /await\s+db\.exec\(\s*`([\s\S]*?)`\s*\);/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        blocks.push(Object.freeze({
            start: match.index,
            end: regex.lastIndex,
            fullSource: match[0],
            sql: match[1].trim(),
        }));
    }
    return blocks;
}

function classifyDdl(sql) {
    const normalized = String(sql || '').trim();
    const table = normalized.match(/^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z0-9_]+)/i);
    if (table) return Object.freeze({ kind: 'table', name: table[1] });
    const index = normalized.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z0-9_]+)/i);
    if (index) return Object.freeze({ kind: 'index', name: index[1] });
    return null;
}

function legacyRaidSchemaExported(source) {
    return /module\.exports\s*=\s*\{[\s\S]*\bensureCloverRaidSchema\b[\s\S]*\};/.test(String(source || ''));
}

function formalSafetyAnalysis() {
    const upSource = String(RAID_SUPPORT_TABLES_MIGRATION.up);
    return Object.freeze([
        Object.freeze({
            marker: 'schema_fail_closed',
            present: upSource.includes('raid_support_schema_mapping_required'),
        }),
        Object.freeze({
            marker: 'index_fail_closed',
            present: upSource.includes('raid_support_index_mapping_required'),
        }),
        Object.freeze({
            marker: 'stored_state_fail_closed',
            present: upSource.includes('raid_support_state_mapping_required'),
        }),
        Object.freeze({
            marker: 'no_historical_raid_reads',
            present: !/\bclover_raids\b|\bclover_raid_participants\b/i.test(upSource),
        }),
        Object.freeze({
            marker: 'no_retroactive_dml',
            present: !/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(upSource),
        }),
    ]);
}

function supportBlocksFromLegacy(legacySource) {
    const range = legacyRaidFunctionRange(legacySource);
    if (!range) return Object.freeze({ range: null, all: Object.freeze([]), support: Object.freeze([]) });

    const tableNames = new Set(RAID_SUPPORT_TABLES.map((entry) => entry.name));
    const indexNames = new Set(RAID_SUPPORT_INDEXES.map((entry) => entry.name));
    const all = extractExecBlocks(range.source);
    const support = all
        .map((block) => Object.freeze({ ...block, ddl: classifyDdl(block.sql) }))
        .filter((block) => block.ddl && (
            (block.ddl.kind === 'table' && tableNames.has(block.ddl.name))
            || (block.ddl.kind === 'index' && indexNames.has(block.ddl.name))
        ));
    return Object.freeze({
        range,
        all: Object.freeze(all),
        support: Object.freeze(support),
    });
}

function analyzeRaidSupportLegacyCoverage(legacySource, prebootstrapKeys = []) {
    const text = String(legacySource || '');
    const extracted = supportBlocksFromLegacy(text);
    const tableMatches = RAID_SUPPORT_TABLES.map((spec) => {
        const found = extracted.support.filter(
            (entry) => entry.ddl.kind === 'table' && entry.ddl.name === spec.name
        );
        return Object.freeze({
            name: spec.name,
            occurrences: found.length,
            matched: found.length === 1 && normalizeSql(found[0].sql) === normalizeSql(spec.sql),
            formalSql: normalizeSql(spec.sql),
            legacySql: found.length === 1 ? normalizeSql(found[0].sql) : null,
        });
    });
    const indexMatches = RAID_SUPPORT_INDEXES.map((spec) => {
        const found = extracted.support.filter(
            (entry) => entry.ddl.kind === 'index' && entry.ddl.name === spec.name
        );
        return Object.freeze({
            name: spec.name,
            occurrences: found.length,
            matched: found.length === 1 && normalizeSql(found[0].sql) === normalizeSql(spec.sql),
            formalSql: normalizeSql(spec.sql),
            legacySql: found.length === 1 ? normalizeSql(found[0].sql) : null,
        });
    });

    return Object.freeze({
        migrationKey: RAID_SUPPORT_TABLES_KEY,
        prebootstrapPromoted: Array.isArray(prebootstrapKeys)
            && prebootstrapKeys.includes(RAID_SUPPORT_TABLES_KEY),
        legacyFunctionPresent: Boolean(extracted.range),
        exported: legacyRaidSchemaExported(text),
        formalTableCount: RAID_SUPPORT_TABLES.length,
        formalIndexCount: RAID_SUPPORT_INDEXES.length,
        legacySupportExecCount: extracted.support.length,
        tableMatches: Object.freeze(tableMatches),
        indexMatches: Object.freeze(indexMatches),
        tablesMatch: tableMatches.length === 6 && tableMatches.every((entry) => entry.matched),
        indexesMatch: indexMatches.length === 6 && indexMatches.every((entry) => entry.matched),
        formalSafety: formalSafetyAnalysis(),
        totalRaidExecBlocks: extracted.all.length,
    });
}

function assertRaidSupportLegacyRemovalPreconditions(legacySource, prebootstrapKeys = []) {
    const analysis = analyzeRaidSupportLegacyCoverage(legacySource, prebootstrapKeys);
    if (!analysis.prebootstrapPromoted) {
        const error = new Error('0025 Raid support nao esta no pre-bootstrap canonico.');
        error.code = 'raid_support_prebootstrap_missing';
        throw error;
    }
    if (!analysis.legacyFunctionPresent) {
        const error = new Error('ensureCloverRaidSchema ausente no legacy.');
        error.code = 'raid_support_legacy_dependency_missing';
        error.marker = 'ensureCloverRaidSchema_function';
        throw error;
    }
    if (!analysis.exported) {
        const error = new Error('Export ensureCloverRaidSchema ausente no legacy.');
        error.code = 'raid_support_legacy_dependency_missing';
        error.marker = 'ensureCloverRaidSchema_export';
        throw error;
    }
    if (analysis.formalTableCount !== 6 || analysis.formalIndexCount !== 6) {
        const error = new Error('Formal 0025 nao possui exatamente 6 tabelas + 6 indices.');
        error.code = 'raid_support_formal_shape_mismatch';
        error.analysis = analysis;
        throw error;
    }
    if (analysis.legacySupportExecCount !== 12) {
        const error = new Error('Legacy pre-cleanup nao possui exatamente 12 blocos DDL auxiliares 0025.');
        error.code = 'raid_support_legacy_precleanup_state_mismatch';
        error.analysis = analysis;
        throw error;
    }
    if (!analysis.tablesMatch) {
        const error = new Error('CREATE TABLE auxiliar no legacy diverge do formal 0025.');
        error.code = 'raid_support_legacy_shape_mismatch';
        error.analysis = analysis;
        throw error;
    }
    if (!analysis.indexesMatch) {
        const error = new Error('CREATE INDEX auxiliar no legacy diverge do formal 0025.');
        error.code = 'raid_support_legacy_index_mismatch';
        error.analysis = analysis;
        throw error;
    }
    const missingSafety = analysis.formalSafety.find((entry) => !entry.present);
    if (missingSafety) {
        const error = new Error(`Garantia formal 0025 ausente: ${missingSafety.marker}.`);
        error.code = 'raid_support_formal_safety_missing';
        error.marker = missingSafety.marker;
        throw error;
    }
    return Object.freeze({ ...analysis, removalGate: 'passed_raid_support_0025_prebootstrap' });
}

function makeSyntheticCleanLegacySource(legacySource, prebootstrapKeys = []) {
    assertRaidSupportLegacyRemovalPreconditions(legacySource, prebootstrapKeys);
    const text = String(legacySource || '');
    const extracted = supportBlocksFromLegacy(text);
    const ranges = extracted.support
        .map((block) => Object.freeze({
            start: extracted.range.start + block.start,
            end: extracted.range.start + block.end,
        }))
        .sort((a, b) => b.start - a.start);

    let cleaned = text;
    for (const range of ranges) {
        cleaned = cleaned.slice(0, range.start) + cleaned.slice(range.end);
    }
    return cleaned;
}

function assertRaidSupportLegacyCleanupState(legacySource, prebootstrapKeys = []) {
    const text = String(legacySource || '');
    if (!Array.isArray(prebootstrapKeys) || !prebootstrapKeys.includes(RAID_SUPPORT_TABLES_KEY)) {
        const error = new Error('0025 Raid support nao esta no pre-bootstrap canonico pos-cleanup.');
        error.code = 'raid_support_prebootstrap_missing';
        throw error;
    }
    const extracted = supportBlocksFromLegacy(text);
    if (!extracted.range) {
        const error = new Error('ensureCloverRaidSchema ausente pos-cleanup.');
        error.code = 'raid_support_legacy_dependency_missing';
        error.marker = 'ensureCloverRaidSchema_function';
        throw error;
    }
    if (!legacyRaidSchemaExported(text)) {
        const error = new Error('Export ensureCloverRaidSchema ausente pos-cleanup.');
        error.code = 'raid_support_legacy_dependency_missing';
        error.marker = 'ensureCloverRaidSchema_export';
        throw error;
    }
    if (extracted.support.length !== 0) {
        const error = new Error('DDL auxiliar Raid 0025 reintroduzido no legacy apos cleanup.');
        error.code = 'raid_support_legacy_cleanup_mismatch';
        error.objects = extracted.support.map((entry) => entry.ddl?.name).filter(Boolean);
        throw error;
    }

    const fn = extracted.range.source;
    const preservedMarkers = [
        'await ensureCloverInventorySchema(db);',
        'CREATE TABLE IF NOT EXISTS clover_raids',
        'CREATE TABLE IF NOT EXISTS clover_raid_participants',
        'CREATE INDEX IF NOT EXISTS idx_clover_raids_status',
    ];
    const missing = preservedMarkers.filter((marker) => !fn.includes(marker));
    if (missing.length) {
        const error = new Error('Cleanup sintetico removeu ownership Raid fora do bloco 0025.');
        error.code = 'raid_support_legacy_cleanup_mismatch';
        error.missingMarkers = missing;
        throw error;
    }

    return Object.freeze({
        migrationKey: RAID_SUPPORT_TABLES_KEY,
        cleanupGate: 'passed_no_legacy_raid_support_ddl',
        exported: true,
        supportExecCount: 0,
        totalRaidExecBlocks: extracted.all.length,
        preservedMarkers: Object.freeze(preservedMarkers),
    });
}

module.exports = {
    analyzeRaidSupportLegacyCoverage,
    assertRaidSupportLegacyCleanupState,
    assertRaidSupportLegacyRemovalPreconditions,
    legacyRaidFunctionRange,
    makeSyntheticCleanLegacySource,
    normalizeSql,
};
