'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    buildRuntimeProvenance,
    scanWorkflowJobs,
    validateSourceContracts,
} = require('../scripts/checkRuntimeReproducibility');

const ROOT = path.resolve(__dirname, '..');

test('fontes canônicas de runtime são coerentes entre si', () => {
    const result = validateSourceContracts(ROOT);
    assert.equal(result.manifest.node.version, '24.19.0');
    assert.equal(result.manifest.node.npmVersion, '11.17.0');
    assert.equal(result.packageLock.lockfileVersion, 3);
    assert.equal(result.workflowScan.findings.length, 0);
});

test('workflows usam Node 24 ou .node-version e nenhum job Node fica órfão', () => {
    const result = scanWorkflowJobs(path.join(ROOT, '.github', 'workflows'));
    assert.ok(result.setupCount >= 38);
    assert.equal(result.findings.length, 0);
});

test('proveniência reporta drift do runner sem mascará-lo quando modo estrito está desligado', () => {
    const result = buildRuntimeProvenance({ root: ROOT, requireCurrentRuntime: false });
    assert.deepEqual(result.expected, { node: '24.19.0', npm: '11.17.0' });
    assert.equal(typeof result.exactRuntimeMatch, 'boolean');
    assert.ok(result.workflowFiles >= 35);
    assert.ok(result.hashes['package-lock.json']);
});

test('scanner detecta job que roda node sem setup explícito', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-workflow-runtime-'));
    try {
        fs.writeFileSync(path.join(dir, 'bad.yml'), [
            'name: Bad',
            'jobs:',
            '  test:',
            '    runs-on: ubuntu-latest',
            '    steps:',
            '      - run: node --check index.js',
            '',
        ].join('\n'));
        const result = scanWorkflowJobs(dir);
        assert.equal(result.findings.length, 1);
        assert.equal(result.findings[0].reason, 'runtime_command_without_setup_node');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('scanner detecta workflow preso a major Node diferente de 24', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-workflow-major-'));
    try {
        fs.writeFileSync(path.join(dir, 'bad.yml'), [
            'name: Bad Major',
            'jobs:',
            '  test:',
            '    runs-on: ubuntu-latest',
            '    steps:',
            '      - uses: actions/setup-node@v4',
            '        with:',
            "          node-version: '22'",
            '      - run: node --check index.js',
            '',
        ].join('\n'));
        const result = scanWorkflowJobs(dir);
        assert.equal(result.findings.length, 1);
        assert.equal(result.findings[0].reason, 'noncanonical_node_major');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
