'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS } = require('../helpers/clover/schemaBasePrebootstrapService');
const {
    assertRaidRewardProposalIdempotencyRuntimeCleanupState,
    cleanGuardEnsure,
    cleanIdempotencyEnsure,
    findFunctionRange,
} = require('../helpers/clover/raidRewardProposalIdempotencyCoverageAudit');

const IDEMPOTENCY_PATH = path.join(__dirname, '..', 'helpers', 'clover', 'raidRewardProposalIdempotencyService.js');
const GUARD_PATH = path.join(__dirname, '..', 'helpers', 'clover', 'raidRewardProposalReviewGuardService.js');
const IDEMPOTENCY_SOURCE = fs.readFileSync(IDEMPOTENCY_PATH, 'utf8');
const GUARD_SOURCE = fs.readFileSync(GUARD_PATH, 'utf8');

function replaceFunction(source, name, replacement) {
    const range = findFunctionRange(source, name);
    assert.ok(range, name);
    return source.slice(0, range.start) + replacement + source.slice(range.end);
}

test('cleanup 0027 preserva C formal no pre-bootstrap e a cadeia C → base', () => {
    const gate = assertRaidRewardProposalIdempotencyRuntimeCleanupState(
        IDEMPOTENCY_SOURCE,
        GUARD_SOURCE,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    assert.equal(gate.cleanupGate, 'passed_no_runtime_0027_ddl');
});

test('cleanup 0027 exige no-op C, mas preserva chamada encadeada para base ate 0028', () => {
    const cleanIdempotency = replaceFunction(
        IDEMPOTENCY_SOURCE,
        'ensureRaidRewardProposalIdempotencySchema',
        cleanIdempotencyEnsure()
    );
    const cleanGuard = replaceFunction(
        GUARD_SOURCE,
        'ensureStrictRewardProposalReviewContext',
        cleanGuardEnsure()
    );
    assert.equal(
        assertRaidRewardProposalIdempotencyRuntimeCleanupState(
            cleanIdempotency,
            cleanGuard,
            DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
        ).cleanupGate,
        'passed_no_runtime_0027_ddl'
    );
});

test('cleanup 0027 falha se C deixa de chamar base', () => {
    const broken = IDEMPOTENCY_SOURCE.replace('await base.ensureRaidRewardProposalSchema(db);', 'void db;');
    assert.throws(
        () => assertRaidRewardProposalIdempotencyRuntimeCleanupState(
            broken,
            GUARD_SOURCE,
            DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
        ),
        (error) => error?.code === 'raid_reward_proposal_idempotency_runtime_cleanup_mismatch'
    );
});
