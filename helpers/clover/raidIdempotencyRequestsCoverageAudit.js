'use strict';

const {
    RAID_IDEMPOTENCY_REQUESTS_INDEXES,
    RAID_IDEMPOTENCY_REQUESTS_KEY,
    RAID_IDEMPOTENCY_REQUESTS_MIGRATION,
    RAID_IDEMPOTENCY_REQUESTS_TABLES,
} = require('./schemaMigrationCatalog');

const OWNERS = Object.freeze([
    Object.freeze({ id: 'creation', functionName: 'ensureRaidCreationIdempotencySchema', prepareName: 'prepareRaidCreation', table: 'clover_raid_creation_requests', index: 'idx_clover_raid_creation_status' }),
    Object.freeze({ id: 'mutation', functionName: 'ensureRaidClaimedMutationSchema', prepareName: 'prepareClaim', table: 'clover_raid_mutation_requests', index: 'idx_clover_raid_mutation_requests_status' }),
]);

function normalizeSql(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .replace(/\bCREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/gi, 'CREATE TABLE')
        .replace(/\bCREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\b/gi, 'CREATE INDEX')
        .trim().replace(/;$/, '').trim();
}

function normalizeFunction(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function findFunctionRange(source, functionName) {
    const text = String(source || '');
    const start = text.indexOf(`async function ${functionName}(`);
    if (start < 0) return null;
    const header = text.slice(start).match(/\)\s*\{/);
    if (!header) return null;
    const brace = start + header.index + header[0].lastIndexOf('{');
    let depth = 0;
    for (let index = brace; index < text.length; index += 1) {
        if (text[index] === '{') depth += 1;
        if (text[index] === '}') {
            depth -= 1;
            if (depth === 0) return Object.freeze({ start, end: index + 1, source: text.slice(start, index + 1) });
        }
    }
    return null;
}

function functionSource(source, functionName) {
    return findFunctionRange(source, functionName)?.source || '';
}

function extractExecSql(functionText) {
    const values = [];
    const regex = /await\s+db\.exec\(\s*`([\s\S]*?)`\s*\);/g;
    let match;
    while ((match = regex.exec(String(functionText || ''))) !== null) values.push(match[1].trim());
    return Object.freeze(values);
}

function ddlName(sql, kind) {
    const pattern = kind === 'table'
        ? /^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z0-9_]+)/i
        : /^CREATE\s+INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z0-9_]+)/i;
    return String(sql || '').trim().match(pattern)?.[1] || null;
}

function exported(source, functionName) {
    return new RegExp(`module\\.exports\\s*=\\s*\\{[\\s\\S]*\\b${functionName}\\b[\\s\\S]*\\};`).test(String(source || ''));
}

function operationalCallsiteCount(source, owner) {
    const text = String(source || '');
    const range = findFunctionRange(text, owner.functionName);
    const outside = range ? text.slice(0, range.start) + text.slice(range.end) : text;
    return (outside.match(new RegExp(`await\\s+${owner.functionName}\\(db\\);`, 'g')) || []).length;
}

function prepareCallsEnsure(source, owner) {
    return new RegExp(`await\\s+${owner.functionName}\\(db\\);`).test(functionSource(source, owner.prepareName));
}

function formalSpec(owner) {
    return Object.freeze({
        table: RAID_IDEMPOTENCY_REQUESTS_TABLES.find((entry) => entry.name === owner.table),
        index: RAID_IDEMPOTENCY_REQUESTS_INDEXES.find((entry) => entry.name === owner.index),
    });
}

function formalSafetyAnalysis() {
    const source = String(RAID_IDEMPOTENCY_REQUESTS_MIGRATION.up);
    return Object.freeze([
        Object.freeze({ marker: 'schema_mapping_required', present: source.includes('raid_idempotency_requests_schema_mapping_required') }),
        Object.freeze({ marker: 'index_mapping_required', present: source.includes('raid_idempotency_requests_index_mapping_required') }),
        Object.freeze({ marker: 'state_mapping_required', present: source.includes('raid_idempotency_requests_state_mapping_required') }),
        Object.freeze({ marker: 'no_historical_raid_reads', present: !/\bclover_raids\b|\bclover_raid_participants\b|\bclover_raid_rewards\b|\bclover_raid_mutation_receipts\b/i.test(source) }),
        Object.freeze({ marker: 'no_retroactive_dml', present: !/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(source) }),
    ]);
}

function analyzeOwner(source, owner) {
    const fn = functionSource(source, owner.functionName);
    const execSql = extractExecSql(fn);
    const tables = execSql.filter((entry) => ddlName(entry, 'table'));
    const indexes = execSql.filter((entry) => ddlName(entry, 'index'));
    const formal = formalSpec(owner);
    const tableSql = tables.filter((entry) => ddlName(entry, 'table') === owner.table);
    const indexSql = indexes.filter((entry) => ddlName(entry, 'index') === owner.index);
    return Object.freeze({
        owner: owner.id,
        functionPresent: Boolean(fn),
        exported: exported(source, owner.functionName),
        operationalCallsiteCount: operationalCallsiteCount(source, owner),
        prepareCallsEnsure: prepareCallsEnsure(source, owner),
        tableCount: tables.length,
        indexCount: indexes.length,
        tableOccurrences: tableSql.length,
        indexOccurrences: indexSql.length,
        tableExact: tableSql.length === 1 && Boolean(formal.table) && normalizeSql(tableSql[0]) === normalizeSql(formal.table.sql),
        indexExact: indexSql.length === 1 && Boolean(formal.index) && normalizeSql(indexSql[0]) === normalizeSql(formal.index.sql),
        functionSource: fn,
    });
}

function analyzeRaidIdempotencyRequestsRuntimeCoverage(creationSource, mutationSource, prebootstrapKeys = []) {
    const owners = Object.freeze([analyzeOwner(creationSource, OWNERS[0]), analyzeOwner(mutationSource, OWNERS[1])]);
    return Object.freeze({
        migrationKey: RAID_IDEMPOTENCY_REQUESTS_KEY,
        prebootstrapPromoted: Array.isArray(prebootstrapKeys) && prebootstrapKeys.includes(RAID_IDEMPOTENCY_REQUESTS_KEY),
        prebootstrapCount: Array.isArray(prebootstrapKeys) ? prebootstrapKeys.length : 0,
        prebootstrapLatest: Array.isArray(prebootstrapKeys) ? prebootstrapKeys.at(-1) : null,
        formalTableCount: RAID_IDEMPOTENCY_REQUESTS_TABLES.length,
        formalIndexCount: RAID_IDEMPOTENCY_REQUESTS_INDEXES.length,
        owners,
        runtimeTableCount: owners.reduce((count, owner) => count + owner.tableOccurrences, 0),
        runtimeIndexCount: owners.reduce((count, owner) => count + owner.indexOccurrences, 0),
        tablesExact: owners.every((owner) => owner.tableExact),
        indexesExact: owners.every((owner) => owner.indexExact),
        formalSafety: formalSafetyAnalysis(),
    });
}

function assertRaidIdempotencyRequestsRuntimeRemovalPreconditions(creationSource, mutationSource, prebootstrapKeys = []) {
    const analysis = analyzeRaidIdempotencyRequestsRuntimeCoverage(creationSource, mutationSource, prebootstrapKeys);
    if (!analysis.prebootstrapPromoted || analysis.prebootstrapCount !== 25 || analysis.prebootstrapLatest !== RAID_IDEMPOTENCY_REQUESTS_KEY) {
        const error = new Error('0026 Raid idempotency requests nao esta congelada no pre-bootstrap canonico.');
        error.code = 'raid_idempotency_requests_prebootstrap_missing';
        throw error;
    }
    if (analysis.formalTableCount !== 2 || analysis.formalIndexCount !== 2) {
        const error = new Error('Formal 0026 nao possui exatamente duas tabelas e dois indices.');
        error.code = 'raid_idempotency_requests_formal_shape_mismatch';
        throw error;
    }
    for (const owner of analysis.owners) {
        if (!owner.functionPresent || !owner.exported || owner.operationalCallsiteCount !== 1 || !owner.prepareCallsEnsure) {
            const error = new Error(`Dependencia runtime 0026 ausente para ${owner.owner}.`);
            error.code = 'raid_idempotency_requests_runtime_dependency_missing';
            error.owner = owner.owner;
            throw error;
        }
        if (owner.tableCount !== 1 || owner.indexCount !== 1 || owner.tableOccurrences !== 1 || owner.indexOccurrences !== 1) {
            const error = new Error(`DDL runtime 0026 pre-cleanup invalido para ${owner.owner}.`);
            error.code = 'raid_idempotency_requests_runtime_precleanup_state_mismatch';
            error.owner = owner.owner;
            throw error;
        }
        if (!owner.tableExact) {
            const error = new Error(`CREATE TABLE runtime 0026 diverge do formal para ${owner.owner}.`);
            error.code = 'raid_idempotency_requests_runtime_shape_mismatch';
            error.owner = owner.owner;
            throw error;
        }
        if (!owner.indexExact) {
            const error = new Error(`CREATE INDEX runtime 0026 diverge do formal para ${owner.owner}.`);
            error.code = 'raid_idempotency_requests_runtime_index_mismatch';
            error.owner = owner.owner;
            throw error;
        }
    }
    const missingSafety = analysis.formalSafety.find((entry) => !entry.present);
    if (missingSafety) {
        const error = new Error(`Garantia formal 0026 ausente: ${missingSafety.marker}.`);
        error.code = 'raid_idempotency_requests_formal_safety_missing';
        error.marker = missingSafety.marker;
        throw error;
    }
    return Object.freeze({ ...analysis, removalGate: 'passed_raid_idempotency_requests_0026_prebootstrap' });
}

function cleanFunction(owner) {
    return `async function ${owner.functionName}(db) {\n    void db;\n}`;
}

function makeSyntheticCleanRuntimeSource(source, owner) {
    const text = String(source || '');
    const range = findFunctionRange(text, owner.functionName);
    if (!range) {
        const error = new Error(`Wrapper 0026 ausente para ${owner.id}.`);
        error.code = 'raid_idempotency_requests_runtime_dependency_missing';
        error.owner = owner.id;
        throw error;
    }
    return text.slice(0, range.start) + cleanFunction(owner) + text.slice(range.end);
}

function assertSyntheticCleanSource(source, owner, prebootstrapKeys = []) {
    if (!Array.isArray(prebootstrapKeys) || !prebootstrapKeys.includes(RAID_IDEMPOTENCY_REQUESTS_KEY)) {
        const error = new Error('0026 Raid idempotency requests ausente do pre-bootstrap pos-cleanup.');
        error.code = 'raid_idempotency_requests_prebootstrap_missing';
        throw error;
    }
    const fn = functionSource(source, owner.functionName);
    if (normalizeFunction(fn) !== normalizeFunction(cleanFunction(owner))) {
        const error = new Error(`Wrapper 0026 pos-cleanup invalido para ${owner.id}.`);
        error.code = 'raid_idempotency_requests_runtime_cleanup_mismatch';
        error.owner = owner.id;
        throw error;
    }
    if (!exported(source, owner.functionName) || operationalCallsiteCount(source, owner) !== 1 || !prepareCallsEnsure(source, owner)) {
        const error = new Error(`API runtime 0026 removida para ${owner.id}.`);
        error.code = 'raid_idempotency_requests_runtime_dependency_missing';
        error.owner = owner.id;
        throw error;
    }
    const forbidden = ['CREATE TABLE', 'CREATE INDEX', owner.table, owner.index, 'db.exec('];
    const present = forbidden.filter((marker) => fn.includes(marker));
    if (present.length) {
        const error = new Error(`DDL 0026 reintroduzido apos cleanup para ${owner.id}.`);
        error.code = 'raid_idempotency_requests_runtime_cleanup_mismatch';
        error.owner = owner.id;
        error.markers = present;
        throw error;
    }
    return Object.freeze({ owner: owner.id, cleanupGate: 'passed_no_runtime_0026_ddl' });
}

function assertRaidIdempotencyRequestsRuntimeCleanupState(creationSource, mutationSource, prebootstrapKeys = []) {
    return Object.freeze({
        creation: assertSyntheticCleanSource(creationSource, OWNERS[0], prebootstrapKeys),
        mutation: assertSyntheticCleanSource(mutationSource, OWNERS[1], prebootstrapKeys),
    });
}

module.exports = {
    OWNERS,
    analyzeRaidIdempotencyRequestsRuntimeCoverage,
    assertRaidIdempotencyRequestsRuntimeCleanupState,
    assertRaidIdempotencyRequestsRuntimeRemovalPreconditions,
    findFunctionRange,
    functionSource,
    makeSyntheticCleanRuntimeSource,
    normalizeSql,
};