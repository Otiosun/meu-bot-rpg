'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { EXPECTED_COVERAGE } = require('../helpers/clover/schemaBaseConsolidationAudit');
const { DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS } = require('../helpers/clover/schemaBasePrebootstrapService');
const {
    RAID_REWARDS_V2_INDEX,
    RAID_REWARDS_V2_KEY,
    RAID_REWARDS_V2_REWARD_TYPES,
} = require('../helpers/clover/schemaMigrationCatalog');
const {
    analyzeRaidRewardsV2RuntimeCoverage,
    assertRaidRewardsV2RuntimeCleanupState,
    assertRaidRewardsV2RuntimeRemovalPreconditions,
    makeSyntheticCleanRuntimeSource,
} = require('../helpers/clover/raidRewardsV2CoverageAudit');

const RUNTIME_SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'helpers', 'clover', 'raidRewardSchema.js'),
    'utf8'
);

test('coverage 0023 prova table-shape, indice, copia e resource_key do runtime contra a formal', () => {
    const analysis = analyzeRaidRewardsV2RuntimeCoverage(
        RUNTIME_SOURCE,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );

    assert.equal(analysis.migrationKey, RAID_REWARDS_V2_KEY);
    assert.equal(analysis.prebootstrapPromoted, true);
    assert.equal(analysis.runtimeFunctionPresent, true);
    assert.equal(analysis.tableShapeMatch, true);
    assert.equal(analysis.indexMatch, true);
    assert.deepEqual(analysis.runtimeIndexColumns, RAID_REWARDS_V2_INDEX.columns);
    assert.equal(analysis.copyProjectionMatch, true);
    assert.equal(analysis.resourceKeyEnsureMatch, true);
    assert.equal(analysis.dependencies.every((item) => item.present), true);
    assert.equal(analysis.formalSafety.every((item) => item.present), true);
    assert.equal(
        Object.values(analysis.runtimeMigrationMarkersPresent).every(Boolean),
        true
    );
    assert.deepEqual(RAID_REWARDS_V2_REWARD_TYPES, [
        'yulls', 'ph', 'stars', 'catalog_item', 'pa', 'pm', 'box',
    ]);

    const gate = assertRaidRewardsV2RuntimeRemovalPreconditions(
        RUNTIME_SOURCE,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    assert.equal(gate.removalGate, 'passed_raid_rewards_v2_prebootstrap');
});

test('coverage 0023 compara a projecao V1->V2 formal e runtime campo a campo', () => {
    const analysis = analyzeRaidRewardsV2RuntimeCoverage(
        RUNTIME_SOURCE,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    assert.deepEqual(analysis.runtimeProjection.target, [
        'id', 'raid_id', 'target_type', 'target_player_id', 'reward_type', 'amount',
        'template_key', 'resource_key', 'label', 'reason', 'status', 'created_by',
        'created_at', 'cancelled_at', 'cancelled_by', 'metadata_json',
    ]);
    assert.deepEqual(analysis.runtimeProjection.select, [
        'id', 'raid_id', 'target_type', 'target_player_id', 'reward_type', 'amount',
        'template_key', 'NULL', 'label', 'reason', 'status', 'created_by',
        'created_at', 'cancelled_at', 'cancelled_by', 'metadata_json',
    ]);
    assert.deepEqual(analysis.runtimeProjection, analysis.formalProjection);
});

test('coverage 0023 falha fechado para shape, indice, copia, resource_key, prebootstrap ou handoff divergente', () => {
    const badShape = RUNTIME_SOURCE.replace(
        "'yulls', 'ph', 'stars', 'catalog_item', 'pa', 'pm', 'box'",
        "'yulls', 'ph', 'stars', 'catalog_item', 'pa', 'pm'"
    );
    assert.throws(
        () => assertRaidRewardsV2RuntimeRemovalPreconditions(
            badShape,
            DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
        ),
        (error) => error?.code === 'raid_rewards_v2_runtime_shape_mismatch'
    );

    const badIndex = RUNTIME_SOURCE.replace(
        'ON clover_raid_rewards (raid_id, status, id);',
        'ON clover_raid_rewards (raid_id, id, status);'
    );
    assert.throws(
        () => assertRaidRewardsV2RuntimeRemovalPreconditions(
            badIndex,
            DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
        ),
        (error) => error?.code === 'raid_rewards_v2_runtime_index_mismatch'
    );

    const badCopy = RUNTIME_SOURCE.replace(
        'template_key, NULL, label, reason, status, created_by,',
        'template_key, template_key, label, reason, status, created_by,'
    );
    assert.throws(
        () => assertRaidRewardsV2RuntimeRemovalPreconditions(
            badCopy,
            DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
        ),
        (error) => error?.code === 'raid_rewards_v2_runtime_copy_mismatch'
    );

    const noResourceEnsure = RUNTIME_SOURCE.replace(
        "    await ensureColumn(db, 'clover_raid_rewards', 'resource_key', 'TEXT DEFAULT NULL');\n",
        ''
    );
    assert.throws(
        () => assertRaidRewardsV2RuntimeRemovalPreconditions(
            noResourceEnsure,
            DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
        ),
        (error) => error?.code === 'raid_rewards_v2_runtime_resource_key_mismatch'
    );

    const no0023 = DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.filter(
        (key) => key !== RAID_REWARDS_V2_KEY
    );
    assert.throws(
        () => assertRaidRewardsV2RuntimeRemovalPreconditions(RUNTIME_SOURCE, no0023),
        (error) => error?.code === 'raid_rewards_v2_prebootstrap_missing'
    );

    const noHandoff = RUNTIME_SOURCE.replace(
        '    await ensureRaidRewardV2Schema(db);\n',
        ''
    );
    assert.throws(
        () => assertRaidRewardsV2RuntimeRemovalPreconditions(
            noHandoff,
            DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
        ),
        (error) => error?.code === 'raid_rewards_v2_runtime_dependency_missing'
            && error?.marker === 'ensureRaidFinalizationSchema_handoff'
    );
});

test('coverage 0023 prova estado sintetico pos-cleanup e rejeita reintroducao de DDL', () => {
    const cleaned = makeSyntheticCleanRuntimeSource(RUNTIME_SOURCE);
    const gate = assertRaidRewardsV2RuntimeCleanupState(
        cleaned,
        DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS
    );
    assert.equal(gate.cleanupGate, 'passed_raid_rewards_v2_runtime_cleanup');
    assert.equal(gate.dependencies.every((item) => item.present), true);

    const reintroduced = cleaned.replace(
        '    await ensureCloverRaidSchema(db);\n',
        "    await ensureCloverRaidSchema(db);\n"
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

test('coverage table-shape 0023 nao adultera o auditor de colunas 156/56/100/0', () => {
    assert.deepEqual(EXPECTED_COVERAGE, {
        totalTargets: 156,
        basePresent: 56,
        baseMissing: 100,
        legacyEnsurePresent: 0,
    });
});
