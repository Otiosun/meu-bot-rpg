'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { EXPECTED_COVERAGE } = require('../helpers/clover/schemaBaseConsolidationAudit');
const { DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS } = require('../helpers/clover/schemaBasePrebootstrapService');
const {
    RAID_REWARDS_V2_KEY,
    RAID_REWARDS_V2_VERSION,
} = require('../helpers/clover/schemaMigrationCatalog');
const {
    CLEAN_RUNTIME_FUNCTION,
    assertRaidRewardsV2RuntimeCleanupState,
} = require('../helpers/clover/raidRewardsV2CoverageAudit');

const RUNTIME_SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'helpers', 'clover', 'raidRewardSchema.js'),
    'utf8'
);

test('cleanup 0023 deixa ensureRaidRewardV2Schema no estado minimo provado pelo coverage', () => {
    const gate = assertRaidRewardsV2RuntimeCleanupState(
        RUNTIME_SOURCE,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    assert.equal(gate.prebootstrapPromoted, true);
    assert.equal(gate.cleanupGate, 'passed_raid_rewards_v2_runtime_cleanup');
    assert.equal(gate.dependencies.every((item) => item.present), true);
    assert.equal(RAID_REWARDS_V2_VERSION, 23);
    assert.equal(RAID_REWARDS_V2_KEY, '0023_raid_rewards_v2');
});

test('cleanup 0023 remove rebuild/DDL/ensure Rewards mas preserva wrapper, handoff, export e helpers publicos', () => {
    assert.match(
        RUNTIME_SOURCE,
        /async function ensureRaidRewardV2Schema\(db\) \{\s*await ensureCloverRaidSchema\(db\);\s*\}/
    );
    for (const forbidden of [
        'SAVEPOINT migrate_clover_raid_rewards_v2',
        'clover_raid_rewards_legacy_v1',
        'CREATE TABLE clover_raid_rewards',
        'INSERT INTO clover_raid_rewards',
        'idx_clover_raid_rewards_raid',
        "ensureColumn(db, 'clover_raid_rewards', 'resource_key'",
    ]) {
        assert.equal(RUNTIME_SOURCE.includes(forbidden), false, forbidden);
    }

    assert.equal(
        RUNTIME_SOURCE.includes('    await ensureRaidRewardV2Schema(db);'),
        true
    );
    assert.match(
        RUNTIME_SOURCE,
        /module\.exports\s*=\s*\{[\s\S]*\bensureRaidRewardV2Schema\b[\s\S]*\};/
    );

    assert.equal(
        RUNTIME_SOURCE.includes('async function ensureColumn(db, table, name, sql)'),
        true
    );
    assert.equal(
        RUNTIME_SOURCE.includes('async function tableColumns(db, table)'),
        true
    );
    assert.match(RUNTIME_SOURCE, /\bensureColumn,\s*[\s\S]*\btableColumns,/);
});

test('cleanup 0023 falha fechado se DDL/ensure Rewards for reintroduzido', () => {
    const reintroduced = RUNTIME_SOURCE.replace(
        /    await ensureCloverRaidSchema\(db\);\r?\n/,
        (match) => match
            + "    await ensureColumn(db, 'clover_raid_rewards', 'resource_key', 'TEXT DEFAULT NULL');\n"
    );
    assert.throws(
        () => assertRaidRewardsV2RuntimeCleanupState(
            reintroduced,
            DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
        ),
        (error) => error?.code === 'raid_rewards_v2_runtime_cleanup_mismatch'
    );
});

test('cleanup 0023 falha fechado sem pre-bootstrap 0023 ou sem handoff finalization', () => {
    const no0023 = DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.filter(
        (key) => key !== RAID_REWARDS_V2_KEY
    );
    assert.throws(
        () => assertRaidRewardsV2RuntimeCleanupState(RUNTIME_SOURCE, no0023),
        (error) => error?.code === 'raid_rewards_v2_prebootstrap_missing'
    );

    const noHandoff = RUNTIME_SOURCE.replace(/    await ensureRaidRewardV2Schema\(db\);\r?\n/, '');
    assert.throws(
        () => assertRaidRewardsV2RuntimeCleanupState(
            noHandoff,
            DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
        ),
        (error) => error?.code === 'raid_rewards_v2_runtime_dependency_missing'
            && error?.marker === 'ensureRaidFinalizationSchema_handoff'
    );
});

test('cleanup table-shape 0023 nao adultera o auditor de colunas 156/56/100/1', () => {
    assert.deepEqual(EXPECTED_COVERAGE, {
        totalTargets: 156,
        basePresent: 56,
        baseMissing: 100,
        legacyEnsurePresent: 1,
    });
});

test('contrato de cleanup esperado pelo auditor continua congelado', () => {
    assert.equal(
        CLEAN_RUNTIME_FUNCTION,
        "async function ensureRaidRewardV2Schema(db) {\n"
            + "    await ensureCloverRaidSchema(db);\n"
            + "}"
    );
});
