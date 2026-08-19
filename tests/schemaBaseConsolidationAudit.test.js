'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { EXPECTED_COVERAGE, POST_SCHEMA_DEPENDENCIES, assertConsolidationPreconditions, classifyLegacySchemaCoverage, collectMigratedColumnTargets } = require('../helpers/clover/schemaBaseConsolidationAudit');
const LEGACY_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'database', 'legacy.js'), 'utf8');

test('catálogo migrado possui 144 targets únicos até a 0020', () => {
 const targets=collectMigratedColumnTargets(); const keys=targets.map(x=>`${x.table}.${x.column}`); assert.equal(targets.length,144); assert.equal(new Set(keys).size,144);
});
test('0020 contribui exatamente 20 targets de Raid e inclui salary_eligible', () => {
 const targets=collectMigratedColumnTargets().filter(x=>x.migrationKey==='0020_raid_v1_bridge'); assert.equal(targets.length,20); assert.equal(targets.filter(x=>x.table==='clover_raids').length,14); assert.equal(targets.filter(x=>x.table==='clover_raid_participants').length,6); assert.ok(targets.some(x=>x.table==='clover_raids'&&x.column==='salary_eligible'&&x.definition==='INTEGER NOT NULL DEFAULT 1'));
});
test('legacy pós-cleanup mantém 56 colunas migradas no CREATE, 88 fora do schema-base e zero ensure coberto', () => {
 const c=classifyLegacySchemaCoverage(LEGACY_SOURCE); for(const [k,v] of Object.entries(EXPECTED_COVERAGE)) assert.equal(c[k],v,k);
});
test('gate de remoção fica liberado somente com dependências pós-DDL preservadas', () => {
 const gate=assertConsolidationPreconditions(LEGACY_SOURCE); assert.equal(gate.requiresLegacyRepairBeforeBaseline,false); assert.equal(gate.removalGate,'passed_canonical_prebootstrap'); assert.equal(gate.dependencies.length,POST_SCHEMA_DEPENDENCIES.length); assert.equal(gate.dependencies.every(x=>x.present),true);
});
test('auditor falha fechado se um ensure coberto da 0018 for reintroduzido', () => {
 const altered=LEGACY_SOURCE+"\nasync function regression(db){ await ensureColumn(db, 'jogadores', 'patente', \"TEXT DEFAULT '-'\"); }\n";
 assert.throws(()=>assertConsolidationPreconditions(altered),e=>e?.code==='schema_base_coverage_mismatch'&&e?.metric==='legacyEnsurePresent'&&e?.observed===1);
});
test('auditor falha fechado se o ensure migrado de Raid for reintroduzido', () => {
 const altered=LEGACY_SOURCE+"\nasync function regressionRaid(db){ await ensureColumn(db, 'clover_raids', 'salary_eligible', 'INTEGER NOT NULL DEFAULT 1'); }\n";
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
