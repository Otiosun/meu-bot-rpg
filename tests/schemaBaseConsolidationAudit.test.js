'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
 EXPECTED_COVERAGE, POST_SCHEMA_DEPENDENCIES, RAID_V2_RUNTIME_DEPENDENCIES, RAID_FINALIZATION_RUNTIME_DEPENDENCIES,
 assertConsolidationPreconditions, assertRaidV2RuntimeCleanupState, assertRaidV2RuntimeRemovalPreconditions,
 assertRaidFinalizationRuntimeRemovalPreconditions, assertRaidFinalizationRuntimeCleanupState,
 classifyLegacySchemaCoverage, classifyRaidV2RuntimeEnsureCoverage, classifyRaidFinalizationRuntimeEnsureCoverage, collectMigratedColumnTargets,
} = require('../helpers/clover/schemaBaseConsolidationAudit');
const { DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS } = require('../helpers/clover/schemaBasePrebootstrapService');
const LEGACY_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'database', 'legacy.js'), 'utf8');
const RAID_V2_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'clover', 'raidV2Schema.js'), 'utf8');
const RAID_FINALIZATION_SCHEMA_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'clover', 'raidRewardSchema.js'), 'utf8');
const RAID_FINALIZATION_POLICY_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'clover', 'raidFinalizationService.js'), 'utf8');
const PRE_CLEANUP_FINALIZATION_ENSURES = [
 "    await ensureColumn(\n        db,\n        'clover_raid_participants',\n        'finalization_status',\n        \"TEXT NOT NULL DEFAULT 'pending'\"\n    );",
 "    await ensureColumn(db, 'clover_raid_participants', 'finalization_note', 'TEXT DEFAULT NULL');",
 "    await ensureColumn(db, 'clover_raid_participants', 'finalized_by', 'TEXT DEFAULT NULL');",
 "    await ensureColumn(db, 'clover_raid_participants', 'finalized_at', 'TEXT DEFAULT NULL');",
].join('\n') + '\n';
const PRE_CLEANUP_FINALIZATION_SOURCE = RAID_FINALIZATION_SCHEMA_SOURCE.replace(
 'async function ensureRaidFinalizationSchema(db) {\n    await ensureCloverRaidSchema(db);\n',
 'async function ensureRaidFinalizationSchema(db) {\n    await ensureCloverRaidSchema(db);\n'
  + PRE_CLEANUP_FINALIZATION_ENSURES
);
const PRE_CLEANUP_ENSURES = [
 "    await ensureColumn(db, 'clover_raids', 'category_key', 'TEXT DEFAULT NULL');",
 "    await ensureColumn(db, 'clover_raids', 'category_label', 'TEXT DEFAULT NULL');",
 "    await ensureColumn(db, 'clover_raids', 'scope_type', \"TEXT NOT NULL DEFAULT 'global'\");",
 "    await ensureColumn(db, 'clover_raids', 'scope_player_id', 'TEXT DEFAULT NULL');",
 "    await ensureColumn(db, 'clover_raids', 'scope_squad_key', 'TEXT DEFAULT NULL');",
 "    await ensureColumn(db, 'clover_raids', 'month_key', 'TEXT DEFAULT NULL');",
 "    await ensureColumn(db, 'clover_raids', 'counts_monthly', 'INTEGER NOT NULL DEFAULT 0');",
 "    await ensureColumn(db, 'clover_raids', 'monthly_limit', 'INTEGER DEFAULT NULL');",
].join('\n') + '\n';
const PRE_CLEANUP_SOURCE = RAID_V2_SOURCE.replace(
 '    await ensureCloverSquadSchema(db);\n',
 '    await ensureCloverSquadSchema(db);\n' + PRE_CLEANUP_ENSURES
);

test('catálogo migrado possui 156 targets únicos até a 0022', () => {
 const targets=collectMigratedColumnTargets(); const keys=targets.map(x=>`${x.table}.${x.column}`); assert.equal(targets.length,156); assert.equal(new Set(keys).size,156);
});
test('0020 contribui exatamente 20 targets de Raid e inclui salary_eligible', () => {
 const targets=collectMigratedColumnTargets().filter(x=>x.migrationKey==='0020_raid_v1_bridge'); assert.equal(targets.length,20); assert.equal(targets.filter(x=>x.table==='clover_raids').length,14); assert.equal(targets.filter(x=>x.table==='clover_raid_participants').length,6); assert.ok(targets.some(x=>x.table==='clover_raids'&&x.column==='salary_eligible'&&x.definition==='INTEGER NOT NULL DEFAULT 1'));
});
test('0021 contribui exatamente 8 targets V2 de clover_raids', () => {
 const targets=collectMigratedColumnTargets().filter(x=>x.migrationKey==='0021_raid_v2_columns'); assert.equal(targets.length,8); assert.equal(targets.every(x=>x.table==='clover_raids'),true); assert.deepEqual(targets.map(x=>x.column),['category_key','category_label','scope_type','scope_player_id','scope_squad_key','month_key','counts_monthly','monthly_limit']);
});
test('0022 contribui exatamente 4 targets de finalização de participantes', () => {
 const targets=collectMigratedColumnTargets().filter(x=>x.migrationKey==='0022_raid_participant_finalization'); assert.equal(targets.length,4); assert.equal(targets.every(x=>x.table==='clover_raid_participants'),true); assert.deepEqual(targets.map(x=>x.column),['finalization_status','finalization_note','finalized_by','finalized_at']);
});
test('legacy pós-cleanup mantém 56 colunas migradas no CREATE, 100 fora do schema-base e zero ensure coberto', () => {
 const c=classifyLegacySchemaCoverage(LEGACY_SOURCE); for(const [k,v] of Object.entries(EXPECTED_COVERAGE)) assert.equal(c[k],v,k);
});
test('gate de remoção fica liberado somente com dependências pós-DDL preservadas', () => {
 const gate=assertConsolidationPreconditions(LEGACY_SOURCE); assert.equal(gate.requiresLegacyRepairBeforeBaseline,false); assert.equal(gate.removalGate,'passed_canonical_prebootstrap'); assert.equal(gate.dependencies.length,POST_SCHEMA_DEPENDENCIES.length); assert.equal(gate.dependencies.every(x=>x.present),true);
});
test('gate V2 pós-cleanup exige zero ensureColumn e preserva dependências runtime', () => {
 const coverage=classifyRaidV2RuntimeEnsureCoverage(RAID_V2_SOURCE); assert.equal(coverage.expected,8); assert.equal(coverage.observed,0); assert.equal(coverage.missing.length,8); assert.deepEqual(coverage.unexpected,[]); assert.deepEqual(coverage.duplicates,[]); assert.deepEqual(coverage.definitionMismatches,[]);
 const gate=assertRaidV2RuntimeCleanupState(RAID_V2_SOURCE,DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS); assert.equal(gate.prebootstrapPromoted,true); assert.equal(gate.ensureColumnTokenPresent,false); assert.equal(gate.cleanupGate,'passed_raid_v2_runtime_cleanup'); assert.equal(gate.dependencies.length,RAID_V2_RUNTIME_DEPENDENCIES.length); assert.equal(gate.dependencies.every(x=>x.present),true);
});
test('gate V2 pré-removal continua fail-closed e gate pós-cleanup rejeita regressão', () => {
 const before=assertRaidV2RuntimeRemovalPreconditions(PRE_CLEANUP_SOURCE,DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS); assert.equal(before.coverage.observed,8); assert.equal(before.removalGate,'passed_raid_v2_prebootstrap');
 const missing=PRE_CLEANUP_SOURCE.replace("    await ensureColumn(db, 'clover_raids', 'category_key', 'TEXT DEFAULT NULL');\n",'');
 assert.throws(()=>assertRaidV2RuntimeRemovalPreconditions(missing,DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),e=>e?.code==='raid_v2_runtime_coverage_mismatch'&&e?.coverage?.missing?.includes('category_key'));
 const badDefinition=PRE_CLEANUP_SOURCE.replace("'category_label', 'TEXT DEFAULT NULL'","'category_label', 'TEXT DEFAULT 0'");
 assert.throws(()=>assertRaidV2RuntimeRemovalPreconditions(badDefinition,DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),e=>e?.code==='raid_v2_runtime_coverage_mismatch'&&e?.coverage?.definitionMismatches?.some(x=>x.column==='category_label'));
 const reintroduced=RAID_V2_SOURCE.replace('    await ensureCloverSquadSchema(db);\n',"    await ensureCloverSquadSchema(db);\n    await ensureColumn(db, 'clover_raids', 'category_key', 'TEXT DEFAULT NULL');\n");
 assert.throws(()=>assertRaidV2RuntimeCleanupState(reintroduced,DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),e=>e?.code==='raid_v2_runtime_cleanup_mismatch'&&e?.coverage?.observed===1&&e?.ensureColumnTokenPresent===true);
 const no0021=DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.filter(key=>key!=='0021_raid_v2_columns');
 assert.throws(()=>assertRaidV2RuntimeCleanupState(RAID_V2_SOURCE,no0021),e=>e?.code==='raid_v2_prebootstrap_missing');
});
test('gate finalization pós-cleanup exige zero ensures de participantes e preserva ensure Rewards/resource_key', () => {
 const coverage=classifyRaidFinalizationRuntimeEnsureCoverage(RAID_FINALIZATION_SCHEMA_SOURCE); assert.equal(coverage.expected,4); assert.equal(coverage.observed,0); assert.equal(coverage.missing.length,4); assert.deepEqual(coverage.unexpected,[]); assert.deepEqual(coverage.duplicates,[]); assert.deepEqual(coverage.definitionMismatches,[]);
 const gate=assertRaidFinalizationRuntimeCleanupState(RAID_FINALIZATION_SCHEMA_SOURCE,RAID_FINALIZATION_POLICY_SOURCE,DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS); assert.equal(gate.prebootstrapPromoted,true); assert.equal(gate.cleanupGate,'passed_raid_finalization_runtime_cleanup'); assert.equal(gate.rewardResourceKeyEnsurePreserved,true); assert.equal(gate.remainingEnsureColumnCalls.length,1); assert.deepEqual(gate.remainingEnsureColumnCalls[0],{table:'clover_raid_rewards',column:'resource_key',definition:'TEXT DEFAULT NULL'}); assert.equal(gate.dependencies.length,RAID_FINALIZATION_RUNTIME_DEPENDENCIES.length); assert.equal(gate.dependencies.every(x=>x.present),true);
});
test('gate finalization pré-removal continua fail-closed e gate pós-cleanup rejeita regressão', () => {
 const before=assertRaidFinalizationRuntimeRemovalPreconditions(PRE_CLEANUP_FINALIZATION_SOURCE,RAID_FINALIZATION_POLICY_SOURCE,DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS); assert.equal(before.coverage.observed,4); assert.equal(before.removalGate,'passed_raid_finalization_prebootstrap');
 const missing=PRE_CLEANUP_FINALIZATION_SOURCE.replace("    await ensureColumn(db, 'clover_raid_participants', 'finalization_note', 'TEXT DEFAULT NULL');\n",'');
 assert.throws(()=>assertRaidFinalizationRuntimeRemovalPreconditions(missing,RAID_FINALIZATION_POLICY_SOURCE,DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),e=>e?.code==='raid_finalization_runtime_coverage_mismatch'&&e?.coverage?.missing?.includes('finalization_note'));
 const badDefinition=PRE_CLEANUP_FINALIZATION_SOURCE.replace("'finalized_by', 'TEXT DEFAULT NULL'","'finalized_by', 'TEXT DEFAULT 0'");
 assert.throws(()=>assertRaidFinalizationRuntimeRemovalPreconditions(badDefinition,RAID_FINALIZATION_POLICY_SOURCE,DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),e=>e?.code==='raid_finalization_runtime_coverage_mismatch'&&e?.coverage?.definitionMismatches?.some(x=>x.column==='finalized_by'));
 const reintroduced=RAID_FINALIZATION_SCHEMA_SOURCE.replace(
  'async function ensureRaidFinalizationSchema(db) {\n    await ensureCloverRaidSchema(db);\n',
  "async function ensureRaidFinalizationSchema(db) {\n    await ensureCloverRaidSchema(db);\n    await ensureColumn(db, 'clover_raid_participants', 'finalization_note', 'TEXT DEFAULT NULL');\n"
 );
 assert.throws(()=>assertRaidFinalizationRuntimeCleanupState(reintroduced,RAID_FINALIZATION_POLICY_SOURCE,DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),e=>e?.code==='raid_finalization_runtime_cleanup_mismatch'&&e?.coverage?.observed===1);
 const noRewardEnsure=RAID_FINALIZATION_SCHEMA_SOURCE.replace("    await ensureColumn(db, 'clover_raid_rewards', 'resource_key', 'TEXT DEFAULT NULL');\n",'');
 assert.throws(()=>assertRaidFinalizationRuntimeCleanupState(noRewardEnsure,RAID_FINALIZATION_POLICY_SOURCE,DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),e=>e?.code==='raid_finalization_runtime_cleanup_mismatch'&&e?.rewardCalls?.length===0);
 const noIndex=RAID_FINALIZATION_SCHEMA_SOURCE.replace('idx_clover_raid_participant_finalization','index_removed_for_test');
 assert.throws(()=>assertRaidFinalizationRuntimeCleanupState(noIndex,RAID_FINALIZATION_POLICY_SOURCE,DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),e=>e?.code==='raid_finalization_runtime_dependency_missing'&&e?.marker==='idx_clover_raid_participant_finalization'&&e?.source==='schema');
 const noLegacyCompatibility=RAID_FINALIZATION_POLICY_SOURCE.replaceAll("'eligible_legacy'","'eligible_legacy_removed_for_test'");
 assert.equal(noLegacyCompatibility.includes("'eligible_legacy'"),false);
 assert.throws(()=>assertRaidFinalizationRuntimeCleanupState(RAID_FINALIZATION_SCHEMA_SOURCE,noLegacyCompatibility,DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS),e=>e?.code==='raid_finalization_runtime_dependency_missing'&&e?.marker==="'eligible_legacy'"&&e?.source==='policy');
 const no0022=DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS.filter(key=>key!=='0022_raid_participant_finalization');
 assert.throws(()=>assertRaidFinalizationRuntimeCleanupState(RAID_FINALIZATION_SCHEMA_SOURCE,RAID_FINALIZATION_POLICY_SOURCE,no0022),e=>e?.code==='raid_finalization_prebootstrap_missing');
});
test('auditor falha fechado se um ensure coberto da 0018 for reintroduzido', () => {
 const altered=LEGACY_SOURCE+"\nasync function regression(db){ await ensureColumn(db, 'jogadores', 'patente', \"TEXT DEFAULT '-'\"); }\n";
 assert.throws(()=>assertConsolidationPreconditions(altered),e=>e?.code==='schema_base_coverage_mismatch'&&e?.metric==='legacyEnsurePresent'&&e?.observed===1);
});
test('auditor falha fechado se o ensure migrado de Raid for reintroduzido', () => {
 const altered=LEGACY_SOURCE+"\nasync function regressionRaid(db){ await ensureColumn(db, 'clover_raids', 'salary_eligible', 'INTEGER NOT NULL DEFAULT 1'); }\n";
 assert.throws(()=>assertConsolidationPreconditions(altered),e=>e?.code==='schema_base_coverage_mismatch'&&e?.metric==='legacyEnsurePresent'&&e?.observed===1);
});
test('auditor falha fechado se ensure de finalização migrado for reintroduzido no legacy', () => {
 const altered=LEGACY_SOURCE+"\nasync function regressionFinalization(db){ await ensureColumn(db, 'clover_raid_participants', 'finalization_note', 'TEXT DEFAULT NULL'); }\n";
 assert.throws(()=>assertConsolidationPreconditions(altered),e=>e?.code==='schema_base_coverage_mismatch'&&e?.metric==='legacyEnsurePresent'&&e?.observed===1);
});
test('auditor falha fechado se índice de aparência normalizada some', () => {
 const altered=LEGACY_SOURCE.replace('idx_jogadores_aparencia_normalizada','index_removed_for_test');
 assert.throws(()=>assertConsolidationPreconditions(altered),e=>e?.code==='schema_base_dependency_missing'&&e?.marker==='idx_jogadores_aparencia_normalizada');
});
test('auditor falha fechado se índice de história some', () => {
 const altered=LEGACY_SOURCE.replace('idx_jogadores_historia_status','index_removed_for_test');
 assert.throws(()=>assertConsolidationPreconditions(altered),e=>e?.code==='schema_base_dependency_missing'&&e?.marker==='idx_jogadores_historia_status');
});
test('auditor falha fechado se índice de jogo some', () => {
 const altered=LEGACY_SOURCE.replace('idx_jogadores_jogo_status','index_removed_for_test');
 assert.throws(()=>assertConsolidationPreconditions(altered),e=>e?.code==='schema_base_dependency_missing'&&e?.marker==='idx_jogadores_jogo_status');
});
test('auditor falha fechado se índice de Squads some', () => {
 const altered=LEGACY_SOURCE.replace('idx_clover_squads_group','index_removed_for_test');
 assert.throws(()=>assertConsolidationPreconditions(altered),e=>e?.code==='schema_base_dependency_missing'&&e?.marker==='idx_clover_squads_group');
});
