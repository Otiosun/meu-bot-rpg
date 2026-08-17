'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    EXPECTED_COVERAGE,
    POST_SCHEMA_DEPENDENCIES,
    assertConsolidationPreconditions,
    classifyLegacySchemaCoverage,
    collectMigratedColumnTargets,
} = require('../helpers/clover/schemaBaseConsolidationAudit');

const LEGACY_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'database', 'legacy.js'), 'utf8');

test('catálogo migrado possui 53 targets únicos até a 0008', () => {
    const targets = collectMigratedColumnTargets();
    const keys = targets.map((item) => `${item.table}.${item.column}`);
    assert.equal(targets.length, 53);
    assert.equal(new Set(keys).size, 53);
});

test('legacy atual classifica 15 colunas no CREATE e 38 ainda ausentes do schema-base', () => {
    const coverage = classifyLegacySchemaCoverage(LEGACY_SOURCE);
    assert.equal(coverage.totalTargets, EXPECTED_COVERAGE.totalTargets);
    assert.equal(coverage.basePresent, EXPECTED_COVERAGE.basePresent);
    assert.equal(coverage.baseMissing, EXPECTED_COVERAGE.baseMissing);
    assert.equal(coverage.legacyEnsurePresent, EXPECTED_COVERAGE.legacyEnsurePresent);
});

test('nenhum ensureColumn coberto pode ser removido antes do pre-bootstrap canônico', () => {
    const gate = assertConsolidationPreconditions(LEGACY_SOURCE);
    assert.equal(gate.requiresLegacyRepairBeforeBaseline, true);
    assert.equal(gate.removalGate, 'blocked_until_canonical_prebootstrap');
    assert.equal(gate.dependencies.length, POST_SCHEMA_DEPENDENCIES.length);
    assert.equal(gate.dependencies.every((item) => item.present), true);
});

test('auditor falha fechado se um ensure coberto some prematuramente', () => {
    const altered = LEGACY_SOURCE.replace(
        "await ensureColumn(db, 'player_onboarding', 'step_payload', \"TEXT DEFAULT '{}'\");",
        '// removido prematuramente'
    );
    assert.throws(
        () => assertConsolidationPreconditions(altered),
        (error) => error?.code === 'schema_base_coverage_mismatch'
            && error?.metric === 'legacyEnsurePresent'
            && error?.observed === 52
    );
});

test('auditor falha fechado se uma dependência pós-DDL some', () => {
    const altered = LEGACY_SOURCE.replace('idx_clover_inventory_template_status', 'index_removed_for_test');
    assert.throws(
        () => assertConsolidationPreconditions(altered),
        (error) => error?.code === 'schema_base_dependency_missing'
            && error?.marker === 'idx_clover_inventory_template_status'
    );
});
