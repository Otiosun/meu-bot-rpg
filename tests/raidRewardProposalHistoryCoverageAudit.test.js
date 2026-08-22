'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS } = require('../helpers/clover/schemaBasePrebootstrapService');
const {
    assertRaidRewardProposalHistoryRuntimeCleanupState,
    cleanFunction,
    findFunctionRange,
} = require('../helpers/clover/raidRewardProposalHistoryCoverageAudit');

const CORE = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'clover', 'raidRewardProposalCoreService.js'), 'utf8');
const SERVICE = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'clover', 'raidRewardProposalService.js'), 'utf8');
const REVISION = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'clover', 'raidRewardProposalRevisionService.js'), 'utf8');

function replaceFunction(source, name) {
    const range = findFunctionRange(source, name);
    assert.ok(range, name);
    return source.slice(0, range.start) + cleanFunction(name) + source.slice(range.end);
}

test('cleanup 0027 preserva pre-bootstrap e a cadeia core → authors → revisions', () => {
    const gate = assertRaidRewardProposalHistoryRuntimeCleanupState(
        CORE,
        SERVICE,
        REVISION,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    assert.equal(gate.cleanupGate, 'passed_no_runtime_0027_ddl');
});

test('cleanup 0027 exige owners no-op e preserva fachada ordenada', () => {
    assert.equal(
        assertRaidRewardProposalHistoryRuntimeCleanupState(
            replaceFunction(CORE, 'ensureRaidRewardProposalSchema'),
            replaceFunction(SERVICE, 'ensureProposalAuthorTrackingSchema'),
            replaceFunction(REVISION, 'ensureProposalRevisionSchema'),
            DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
        ).cleanupGate,
        'passed_no_runtime_0027_ddl'
    );
});

test('coverage 0027 falha se a fachada altera a ordem historica', () => {
    const broken = SERVICE.replace('await core.ensureRaidRewardProposalSchema(db);', 'void db;');
    assert.throws(
        () => assertRaidRewardProposalHistoryRuntimeCleanupState(
            CORE,
            broken,
            REVISION,
            DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
        ),
        (error) => error?.code === 'raid_reward_proposal_history_runtime_dependency_missing'
    );
});
