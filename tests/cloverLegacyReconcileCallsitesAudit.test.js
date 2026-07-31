'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function runScanner(root, output, extraArgs = []) {
    return execFileSync(process.execPath, [
        path.resolve(__dirname, '../scripts/auditLegacySquadReconcileCallsites.js'),
        `--root=${root}`,
        `--output=${output}`,
        ...extraArgs,
    ], {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
    });
}

function createFixture(root) {
    fs.mkdirSync(path.join(root, 'helpers'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'helpers', 'source.js'), `
const {
    reconcileSquadStars,
    syncAllSquadGroupDescriptions,
} = require('./squadService');

async function syncMissingVisibleMemberStars() {
    return [];
}

async function run(db) {
    await reconcileSquadStars(db, 'coringas_magenta');
    return { source: 'squad_reconcile' };
}

module.exports = {
    syncMissingVisibleMemberStars,
};
`, 'utf8');
    fs.writeFileSync(path.join(root, 'tests', 'source.test.js'), `
// reconcileSquadStars é mencionado somente em teste.
const value = 'squad_reconcile';
`, 'utf8');
}

test('scanner separa imports, definições, exports, testes e referências reais', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-reconcile-scan-'));
    const output = path.join(root, 'report.json');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    createFixture(root);

    const stdout = runScanner(root, output);
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));

    assert.match(stdout, /Referências de runtime: 2/);
    assert.equal(report.reportVersion, 'clover-legacy-squad-reconcile-callsites-v2');
    assert.equal(report.summary.runtimeReferences, 2);
    assert.deepEqual(
        report.runtimeReferences.map((item) => item.token).sort(),
        ['reconcileSquadStars', 'squad_reconcile']
    );

    const classifications = new Map(
        report.matches.map((item) => [`${item.path}:${item.line}:${item.token}`, item.classification])
    );
    assert.equal(
        [...classifications.entries()].some(([key, value]) => key.includes('reconcileSquadStars') && value === 'import'),
        true
    );
    assert.equal(
        [...classifications.entries()].some(([key, value]) => key.includes('syncMissingVisibleMemberStars') && value === 'definition'),
        true
    );
    assert.equal(
        [...classifications.entries()].some(([key, value]) => key.includes('syncMissingVisibleMemberStars') && value === 'export'),
        true
    );
    assert.equal(report.matches.filter((item) => item.classification === 'test').length, 2);
});

test('--fail-on-runtime-callsite retorna 2 quando existe referência ativa', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-reconcile-fail-'));
    const output = path.join(root, 'report.json');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    createFixture(root);

    let status = null;
    try {
        runScanner(root, output, ['--fail-on-runtime-callsite']);
    } catch (error) {
        status = error.status;
    }

    assert.equal(status, 2);
    assert.equal(fs.existsSync(output), true);
});
