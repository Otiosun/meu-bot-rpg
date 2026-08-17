'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    assertLegacyDatabaseBypassGate,
    auditLegacyDatabaseBypasses,
    extractDirectLegacyImports,
} = require('../helpers/clover/legacyDatabaseBypassAudit');

function fixtureRepo(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-legacy-bypass-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    const prodLegacySpecifier = './database/' + 'legacy';
    const testLegacySpecifier = '../database/' + 'legacy';
    fs.writeFileSync(path.join(dir, 'database.js'), [
        "'use strict';",
        `const legacyDatabase = require('${prodLegacySpecifier}');`,
        'function choose(options = {}) { return options.createLegacyDatabase || legacyDatabase.criarBanco; }',
        'module.exports = { choose };',
        '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'tests', 'databaseMigrationCatalog.test.js'), [
        "'use strict';",
        `const legacyDatabase = require('${testLegacySpecifier}');`,
        'void legacyDatabase.criarBanco;',
        'const fixture = { createLegacyDatabase: async () => {} };',
        'void fixture;',
        '',
    ].join('\n'));
    return dir;
}

test('parser detecta require/import direto do legacy', () => {
    const legacy = 'database/' + 'legacy';
    const source = [
        `const a = require('./${legacy}');`,
        `const b = import('../${legacy}.js');`,
        `import c from '../../${legacy}';`,
    ].join('\n');
    const found = extractDirectLegacyImports(source).map((item) => item.specifier);
    assert.deepEqual(found, [
        './database/legacy',
        '../database/legacy.js',
        '../../database/legacy',
    ]);
});

test('gate aceita somente ponte canônica + fixture de teste allowlisted', (t) => {
    const dir = fixtureRepo(t);
    const result = assertLegacyDatabaseBypassGate(dir);
    assert.equal(result.ok, true);
    assert.equal(result.directImportCount, 2);
    assert.equal(result.productionDirectImports, 1);
    assert.equal(result.testDirectImports, 1);
    assert.equal(result.blockers.length, 0);
    assert.equal(result.removalGate, 'legacy_direct_bypass_clean');
});

test('gate rejeita import direto em helper de produção', (t) => {
    const dir = fixtureRepo(t);
    fs.mkdirSync(path.join(dir, 'helpers'), { recursive: true });
    const badSpecifier = '../database/' + 'legacy';
    fs.writeFileSync(path.join(dir, 'helpers', 'bad.js'), `module.exports = require('${badSpecifier}');\n`);
    const result = auditLegacyDatabaseBypasses(dir);
    assert.equal(result.ok, false);
    assert.ok(result.blockers.some((item) =>
        item.code === 'legacy_direct_import_not_allowed' && item.path === 'helpers/bad.js'
    ));
});

test('gate rejeita injeção createLegacyDatabase em código de produção', (t) => {
    const dir = fixtureRepo(t);
    fs.writeFileSync(path.join(dir, 'worker.js'), 'start({ createLegacyDatabase: async () => null });\n');
    const result = auditLegacyDatabaseBypasses(dir);
    assert.equal(result.ok, false);
    assert.ok(result.blockers.some((item) =>
        item.code === 'custom_legacy_injection_in_production' && item.path === 'worker.js'
    ));
});

test('gate falha se a ponte canônica esperada desaparecer', (t) => {
    const dir = fixtureRepo(t);
    fs.writeFileSync(path.join(dir, 'database.js'), "'use strict';\nmodule.exports = {};\n");
    assert.throws(
        () => assertLegacyDatabaseBypassGate(dir),
        (error) => error?.code === 'legacy_database_bypass_detected'
            && error.blockers.some((item) => item.code === 'expected_legacy_bridge_missing')
    );
});

test('checkout atual possui exatamente uma ponte de produção e uma fixture allowlisted', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const result = assertLegacyDatabaseBypassGate(repoRoot);
    assert.equal(result.directImportCount, 2);
    assert.equal(result.productionDirectImports, 1);
    assert.equal(result.testDirectImports, 1);
    assert.equal(result.blockers.length, 0);
});
