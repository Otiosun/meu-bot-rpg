'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { EXPECTED_COVERAGE, POST_SCHEMA_DEPENDENCIES, assertConsolidationPreconditions, classifyLegacySchemaCoverage, collectMigratedColumnTargets } = require('../helpers/clover/schemaBaseConsolidationAudit');
const LEGACY_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'database', 'legacy.js'), 'utf8');

test('catálogo migrado possui 88 targets únicos até a 0012', () => {
 const targets=collectMigratedColumnTargets(); const keys=targets.map(x=>`${x.table}.${x.column}`); assert.equal(targets.length,88); assert.equal(new Set(keys).size,88);
});
test('legacy pós-cleanup mantém 28 colunas no CREATE, 60 fora do schema-base e zero ensure coberto', () => {
 const c=classifyLegacySchemaCoverage(LEGACY_SOURCE); for(const [k,v] of Object.entries(EXPECTED_COVERAGE)) assert.equal(c[k],v,k);
});
test('gate de remoção fica liberado somente com dependências pós-DDL preservadas', () => {
 const gate=assertConsolidationPreconditions(LEGACY_SOURCE); assert.equal(gate.requiresLegacyRepairBeforeBaseline,false); assert.equal(gate.removalGate,'passed_canonical_prebootstrap'); assert.equal(gate.dependencies.length,POST_SCHEMA_DEPENDENCIES.length); assert.equal(gate.dependencies.every(x=>x.present),true);
});
test('auditor falha fechado se um ensure coberto da 0012 for reintroduzido', () => {
 const altered=LEGACY_SOURCE+"\nasync function regression(db){ await ensureColumn(db, 'jogadores', 'personagem_aparencia_status', \"TEXT DEFAULT 'pending'\"); }\n";
 assert.throws(()=>assertConsolidationPreconditions(altered),e=>e?.code==='schema_base_coverage_mismatch'&&e?.metric==='legacyEnsurePresent'&&e?.observed===1);
});
test('auditor falha fechado se índice de aparência normalizada some', () => {
 const altered=LEGACY_SOURCE.replace('idx_jogadores_aparencia_normalizada','index_removed_for_test');
 assert.throws(()=>assertConsolidationPreconditions(altered),e=>e?.code==='schema_base_dependency_missing'&&e?.marker==='idx_jogadores_aparencia_normalizada');
});
test('auditor falha fechado se índice de jogo dependente do status de aparência some', () => {
 const altered=LEGACY_SOURCE.replace('idx_jogadores_jogo_status','index_removed_for_test');
 assert.throws(()=>assertConsolidationPreconditions(altered),e=>e?.code==='schema_base_dependency_missing'&&e?.marker==='idx_jogadores_jogo_status');
});
