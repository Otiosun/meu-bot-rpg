'use strict';

const {
    RAID_REWARD_PROPOSAL_BASE_OBJECTS,
    RAID_REWARD_PROPOSAL_HISTORY_KEY,
    RAID_REWARD_PROPOSAL_HISTORY_MIGRATION,
    RAID_REWARD_PROPOSAL_HISTORY_OBJECTS,
} = require('./schemaMigrationCatalog');

const OWNERS = Object.freeze([
    Object.freeze({ source: 'core', functionName: 'ensureRaidRewardProposalSchema' }),
    Object.freeze({ source: 'service', functionName: 'ensureProposalAuthorTrackingSchema' }),
    Object.freeze({ source: 'revision', functionName: 'ensureProposalRevisionSchema' }),
]);

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
        .replace(/\$\{PROPOSAL_AUTHOR_TABLE\}/g, 'clover_raid_reward_proposal_authors')
        .replace(/\$\{PROPOSAL_AUTHOR_INSERT_TRIGGER\}/g, 'trg_clover_raid_reward_proposal_author_insert')
        .replace(/\$\{PROPOSAL_AUTHOR_RESUBMIT_TRIGGER\}/g, 'trg_clover_raid_reward_proposal_author_resubmit')
        .replace(/\$\{PROPOSAL_SELF_REVIEW_TRIGGER\}/g, 'trg_clover_raid_reward_proposal_self_review_block')
        .replace(/\$\{PROPOSAL_REVISION_TABLE\}/g, 'clover_raid_reward_proposal_revisions')
        .replace(/\$\{PROPOSAL_REVISION_INSERT_TRIGGER\}/g, 'trg_clover_raid_reward_proposal_revision_insert')
        .replace(/\$\{PROPOSAL_REVISION_RESUBMIT_TRIGGER\}/g, 'trg_clover_raid_reward_proposal_revision_resubmit')
        .replace(/\$\{PROPOSAL_REVISION_UPDATE_BLOCK_TRIGGER\}/g, 'trg_clover_raid_reward_proposal_revision_update_block')
        .replace(/\$\{PROPOSAL_REVISION_DELETE_BLOCK_TRIGGER\}/g, 'trg_clover_raid_reward_proposal_revision_delete_block');
}

function templateSql(functionText) {
    const values = [];
    const regex = /`([\s\S]*?)`/g;
    let match;
    while ((match = regex.exec(String(functionText || ''))) !== null) values.push(expandRuntimeNames(match[1]));
    return values.filter((sql) => /^\s*CREATE\s+/i.test(sql)).map(normalizeSql);
}

function analyzeRaidRewardProposalHistoryRuntimeCoverage(coreSource, serviceSource, revisionSource, prebootstrapKeys = []) {
    const sources = { core: coreSource, service: serviceSource, revision: revisionSource };
    const runtimeSql = OWNERS.flatMap((owner) => templateSql(functionSource(sources[owner.source], owner.functionName)));
    const expected = [...RAID_REWARD_PROPOSAL_BASE_OBJECTS, ...RAID_REWARD_PROPOSAL_HISTORY_OBJECTS]
        .map((object) => Object.freeze({ name: object.name, sql: normalizeSql(object.sql) }));
    const serviceEnsure = functionSource(serviceSource, 'ensureRaidRewardProposalSchema');
    return Object.freeze({
        migrationKey: RAID_REWARD_PROPOSAL_HISTORY_KEY,
        prebootstrapPromoted: Array.isArray(prebootstrapKeys) && prebootstrapKeys.includes(RAID_REWARD_PROPOSAL_HISTORY_KEY),
        prebootstrapCount: Array.isArray(prebootstrapKeys) ? prebootstrapKeys.length : 0,
        prebootstrapLatest: Array.isArray(prebootstrapKeys) ? prebootstrapKeys.at(-1) : null,
        exportsPresent: OWNERS.every((owner) => exported(sources[owner.source], owner.functionName)),
        runtimeObjectCount: runtimeSql.length,
        expectedObjectCount: expected.length,
        objects: Object.freeze(expected.map((object) => Object.freeze({
            name: object.name,
            occurrences: runtimeSql.filter((sql) => sql === object.sql).length,
        }))),
        serviceOrder: serviceEnsure.includes('await core.ensureRaidRewardProposalSchema(db);')
            && serviceEnsure.includes('await ensureProposalAuthorTrackingSchema(db);')
            && serviceEnsure.includes('await revisionService.ensureProposalRevisionSchema(db);')
            && serviceEnsure.indexOf('await core.ensureRaidRewardProposalSchema(db);')
                < serviceEnsure.indexOf('await ensureProposalAuthorTrackingSchema(db);')
            && serviceEnsure.indexOf('await ensureProposalAuthorTrackingSchema(db);')
                < serviceEnsure.indexOf('await revisionService.ensureProposalRevisionSchema(db);'),
        formalFailClosed: String(RAID_REWARD_PROPOSAL_HISTORY_MIGRATION.up).includes('raid_reward_proposal_history_schema_mapping_required')
            && String(RAID_REWARD_PROPOSAL_HISTORY_MIGRATION.up).includes('raid_reward_proposal_history_state_mapping_required'),
    });
}

function assertRaidRewardProposalHistoryRuntimeRemovalPreconditions(coreSource, serviceSource, revisionSource, prebootstrapKeys = []) {
    const analysis = analyzeRaidRewardProposalHistoryRuntimeCoverage(coreSource, serviceSource, revisionSource, prebootstrapKeys);
    if (!analysis.prebootstrapPromoted) {
        const error = new Error('0027 nao esta congelada no pre-bootstrap canonico.');
        error.code = 'raid_reward_proposal_history_prebootstrap_missing';
        throw error;
    }
    if (!analysis.exportsPresent || !analysis.serviceOrder || analysis.runtimeObjectCount !== analysis.expectedObjectCount
        || analysis.objects.some((object) => object.occurrences !== 1) || !analysis.formalFailClosed) {
        const error = new Error('Cobertura runtime de historico 0028 diverge do formal.');
        error.code = 'raid_reward_proposal_history_runtime_shape_mismatch';
        throw error;
    }
    return Object.freeze({ ...analysis, removalGate: 'passed_raid_reward_proposal_history_0027_prebootstrap' });
}

function cleanFunction(functionName) {
    return `async function ${functionName}(db) {\n    void db;\n}`;
}

function assertRaidRewardProposalHistoryRuntimeCleanupState(coreSource, serviceSource, revisionSource, prebootstrapKeys = []) {
    if (!Array.isArray(prebootstrapKeys) || !prebootstrapKeys.includes(RAID_REWARD_PROPOSAL_HISTORY_KEY)) {
        const error = new Error('0027 ausente do pre-bootstrap pos-cleanup.');
        error.code = 'raid_reward_proposal_history_prebootstrap_missing';
        throw error;
    }
    const sources = { core: coreSource, service: serviceSource, revision: revisionSource };
    for (const owner of OWNERS) {
        if (normalizeSql(functionSource(sources[owner.source], owner.functionName)) !== normalizeSql(cleanFunction(owner.functionName))) {
        const error = new Error(`Owner runtime 0027 invalido: ${owner.functionName}.`);
            error.code = 'raid_reward_proposal_history_runtime_cleanup_mismatch';
            error.owner = owner.functionName;
            throw error;
        }
    }
    const serviceEnsure = functionSource(serviceSource, 'ensureRaidRewardProposalSchema');
    if (!serviceEnsure.includes('await core.ensureRaidRewardProposalSchema(db);')
        || !serviceEnsure.includes('await ensureProposalAuthorTrackingSchema(db);')
        || !serviceEnsure.includes('await revisionService.ensureProposalRevisionSchema(db);')) {
        const error = new Error('Fachada de proposta perdeu a cadeia de owners historicos.');
        error.code = 'raid_reward_proposal_history_runtime_dependency_missing';
        throw error;
    }
    return Object.freeze({ cleanupGate: 'passed_no_runtime_0027_ddl' });
}

module.exports = {
    OWNERS,
    analyzeRaidRewardProposalHistoryRuntimeCoverage,
    assertRaidRewardProposalHistoryRuntimeCleanupState,
    assertRaidRewardProposalHistoryRuntimeRemovalPreconditions,
    cleanFunction,
    findFunctionRange,
    functionSource,
    normalizeSql,
};
