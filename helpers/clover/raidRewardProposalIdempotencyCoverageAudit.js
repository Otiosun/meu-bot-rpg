'use strict';

const {
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY,
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_MIGRATION,
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS,
} = require('./schemaMigrationCatalog');

const IDEMPOTENCY_ENSURE = 'ensureRaidRewardProposalIdempotencySchema';
const GUARD_ENSURE = 'ensureStrictRewardProposalReviewContext';

function normalizeSql(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .replace(/\bCREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/gi, 'CREATE TABLE')
        .replace(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/gi, (match) => match.replace(/\s+IF\s+NOT\s+EXISTS/i, ''))
        .replace(/\bCREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\b/gi, 'CREATE TRIGGER')
        .trim().replace(/;$/, '').trim();
}

function findFunctionRange(source, functionName) {
    const text = String(source || '');
    const marker = text.includes(`async function ${functionName}(`)
        ? `async function ${functionName}(`
        : `function ${functionName}(`;
    const start = text.indexOf(marker);
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

function exported(source, functionName) {
    return new RegExp(`module\\.exports\\s*=\\s*\\{[\\s\\S]*\\b${functionName}\\b[\\s\\S]*\\};`).test(String(source || ''));
}

function expandRuntimeNames(value) {
    return String(value || '')
        .replace(/\$\{INTENT_TABLE\}/g, 'clover_raid_reward_review_intents')
        .replace(/\$\{EVENT_TABLE\}/g, 'clover_raid_reward_review_events')
        .replace(/\$\{REVIEW_CAPTURE_TRIGGER\}/g, 'trg_clover_raid_reward_review_capture')
        .replace(/\$\{EVENT_UPDATE_BLOCK_TRIGGER\}/g, 'trg_clover_raid_reward_review_event_update_block')
        .replace(/\$\{EVENT_DELETE_BLOCK_TRIGGER\}/g, 'trg_clover_raid_reward_review_event_delete_block')
        .replace(/\$\{idempotency\.INTENT_TABLE\}/g, 'clover_raid_reward_review_intents')
        .replace(/\$\{STRICT_REVIEW_CONTEXT_TRIGGER\}/g, 'trg_clover_raid_reward_review_context_guard');
}

function templateSql(functionText) {
    const values = [];
    const regex = /`([\s\S]*?)`/g;
    let match;
    while ((match = regex.exec(String(functionText || ''))) !== null) values.push(expandRuntimeNames(match[1]));
    return values;
}

function runtimeObjectSql(idempotencySource, guardSource) {
    const idempotency = templateSql(functionSource(idempotencySource, IDEMPOTENCY_ENSURE));
    const guard = templateSql(functionSource(guardSource, 'strictReviewContextTriggerSql'));
    return Object.freeze([...idempotency, ...guard].filter((sql) => /^\s*CREATE\s+/i.test(sql)));
}

function requiredRuntimeSpecs() {
    return RAID_REWARD_PROPOSAL_IDEMPOTENCY_OBJECTS.map((spec) => Object.freeze({
        name: spec.name,
        exact: normalizeSql(spec.sql),
    }));
}

function analyzeRaidRewardProposalIdempotencyRuntimeCoverage(idempotencySource, guardSource, prebootstrapKeys = []) {
    const idempotencyEnsure = functionSource(idempotencySource, IDEMPOTENCY_ENSURE);
    const guardEnsure = functionSource(guardSource, GUARD_ENSURE);
    const runtimeSql = runtimeObjectSql(idempotencySource, guardSource).map(normalizeSql);
    const expected = requiredRuntimeSpecs();
    return Object.freeze({
        migrationKey: RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY,
        prebootstrapPromoted: Array.isArray(prebootstrapKeys) && prebootstrapKeys.includes(RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY),
        prebootstrapCount: Array.isArray(prebootstrapKeys) ? prebootstrapKeys.length : 0,
        prebootstrapLatest: Array.isArray(prebootstrapKeys) ? prebootstrapKeys.at(-1) : null,
        idempotencyEnsure,
        guardEnsure,
        idempotencyExported: exported(idempotencySource, IDEMPOTENCY_ENSURE),
        guardExported: exported(guardSource, GUARD_ENSURE),
        runtimeObjectCount: runtimeSql.length,
        expectedObjectCount: expected.length,
        objects: Object.freeze(expected.map((spec) => Object.freeze({
            name: spec.name,
            occurrences: runtimeSql.filter((sql) => sql === spec.exact).length,
        }))),
        baseBeforeRuntimeDdl: idempotencyEnsure.indexOf('await base.ensureRaidRewardProposalSchema(db);') >= 0
            && idempotencyEnsure.indexOf('await base.ensureRaidRewardProposalSchema(db);')
                < idempotencyEnsure.search(/CREATE\s+(?:TABLE|INDEX|TRIGGER)/),
        baseImportExact: /const\s+base\s*=\s*require\(['"]\.\/raidRewardProposalService['"]\);/.test(String(idempotencySource || '')),
        prepareCallsEnsure: functionSource(idempotencySource, 'prepareReviewIntent').includes(`await ${IDEMPOTENCY_ENSURE}(db);`),
        guardCallsIdempotencyEnsure: guardEnsure.includes(`await idempotency.${IDEMPOTENCY_ENSURE}(db);`),
        formalFailClosed: String(RAID_REWARD_PROPOSAL_IDEMPOTENCY_MIGRATION.up).includes('raid_reward_proposal_idempotency_base_mapping_required')
            && String(RAID_REWARD_PROPOSAL_IDEMPOTENCY_MIGRATION.up).includes('raid_reward_proposal_idempotency_schema_mapping_required'),
    });
}

function assertRaidRewardProposalIdempotencyRuntimeRemovalPreconditions(idempotencySource, guardSource, prebootstrapKeys = []) {
    const analysis = analyzeRaidRewardProposalIdempotencyRuntimeCoverage(idempotencySource, guardSource, prebootstrapKeys);
    if (!analysis.prebootstrapPromoted) {
        const error = new Error('0028 nao esta congelada no pre-bootstrap canonico.');
        error.code = 'raid_reward_proposal_idempotency_prebootstrap_missing';
        throw error;
    }
    if (!analysis.baseImportExact || !analysis.baseBeforeRuntimeDdl || !analysis.prepareCallsEnsure || !analysis.guardCallsIdempotencyEnsure) {
        const error = new Error('Cadeia runtime C → base de propostas nao preservada para 0027.');
        error.code = 'raid_reward_proposal_idempotency_runtime_dependency_missing';
        throw error;
    }
    if (!analysis.idempotencyExported || !analysis.guardExported || analysis.runtimeObjectCount !== analysis.expectedObjectCount) {
        const error = new Error('Cobertura runtime 0028 incompleta.');
        error.code = 'raid_reward_proposal_idempotency_runtime_shape_mismatch';
        throw error;
    }
    if (analysis.objects.some((object) => object.occurrences !== 1) || !analysis.formalFailClosed) {
        const error = new Error('DDL runtime 0028 diverge do formal ou perdeu fail-closed.');
        error.code = 'raid_reward_proposal_idempotency_runtime_shape_mismatch';
        throw error;
    }
    return Object.freeze({ ...analysis, removalGate: 'passed_raid_reward_proposal_idempotency_0028_prebootstrap' });
}

function cleanIdempotencyEnsure() {
    return `async function ${IDEMPOTENCY_ENSURE}(db) {\n    await base.ensureRaidRewardProposalSchema(db);\n    void db;\n}`;
}

function cleanGuardEnsure() {
    return `async function ${GUARD_ENSURE}(db) {\n    await idempotency.${IDEMPOTENCY_ENSURE}(db);\n    void db;\n}`;
}

function assertRaidRewardProposalIdempotencyRuntimeCleanupState(idempotencySource, guardSource, prebootstrapKeys = []) {
    if (!Array.isArray(prebootstrapKeys) || !prebootstrapKeys.includes(RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY)) {
        const error = new Error('0028 ausente do pre-bootstrap pos-cleanup.');
        error.code = 'raid_reward_proposal_idempotency_prebootstrap_missing';
        throw error;
    }
    const actualIdempotency = functionSource(idempotencySource, IDEMPOTENCY_ENSURE);
    const actualGuard = functionSource(guardSource, GUARD_ENSURE);
    if (normalizeSql(actualIdempotency) !== normalizeSql(cleanIdempotencyEnsure())
        || normalizeSql(actualGuard) !== normalizeSql(cleanGuardEnsure())) {
        const error = new Error('Wrapper runtime 0028 pos-cleanup diverge do contrato.');
        error.code = 'raid_reward_proposal_idempotency_runtime_cleanup_mismatch';
        throw error;
    }
    return Object.freeze({ cleanupGate: 'passed_no_runtime_0028_ddl' });
}

module.exports = {
    analyzeRaidRewardProposalIdempotencyRuntimeCoverage,
    assertRaidRewardProposalIdempotencyRuntimeCleanupState,
    assertRaidRewardProposalIdempotencyRuntimeRemovalPreconditions,
    cleanGuardEnsure,
    cleanIdempotencyEnsure,
    findFunctionRange,
    functionSource,
    normalizeSql,
};
