'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    normalizeReferenceDate,
    parseArgs,
    runShadowAudit,
    sameSha,
} = require('../scripts/auditCanonicalRoleShadow');

test('parseArgs aceita filtros repetidos e proteções', () => {
    const options = parseArgs([
        '--db=/tmp/source.sqlite',
        '--output', '/tmp/report.json',
        '--subject=a@lid', '--subject', 'b@lid',
        '--scope=lobos', '--scope', 'trevos',
        '--reference-date=2026-07-31T00:00:00.000Z',
        '--expected-auditor-sha=abc123',
        '--fail-on-critical', '--json-only',
    ]);
    assert.equal(options.db, '/tmp/source.sqlite');
    assert.equal(options.output, '/tmp/report.json');
    assert.deepEqual(options.subjectIds, ['a@lid', 'b@lid']);
    assert.deepEqual(options.scopeKeys, ['lobos', 'trevos']);
    assert.equal(options.expectedAuditorSha, 'abc123');
    assert.equal(options.failOnCritical, true);
    assert.equal(options.jsonOnly, true);
});

test('sameSha aceita SHA curto somente quando há prefixo real', () => {
    assert.equal(sameSha('abcdef1234', 'abcdef'), true);
    assert.equal(sameSha('abcdef', 'abcdef1234'), true);
    assert.equal(sameSha('abcdef', 'abc999'), false);
    assert.equal(sameSha(null, 'abc'), null);
});

test('normalizeReferenceDate rejeita valor inválido', () => {
    assert.equal(normalizeReferenceDate('2026-07-31').toISOString().startsWith('2026-07-31'), true);
    assert.throws(() => normalizeReferenceDate('não-é-data'), { code: 'invalid_reference_date' });
});

test('auditoria preserva o arquivo, fecha DB e grava relatório privado', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-shadow-'));
    const dbPath = path.join(directory, 'snapshot.sqlite');
    const outputPath = path.join(directory, 'evidence', 'shadow.json');
    fs.writeFileSync(dbPath, 'snapshot-imutavel');
    let closed = false;
    let receivedOptions = null;
    const report = await runShadowAudit({
        db: dbPath,
        output: outputPath,
        subjectIds: ['a@lid'],
        scopeKeys: ['lobos'],
        referenceDate: '2026-07-31T00:00:00.000Z',
        expectedAuditorSha: 'abc123',
    }, {
        currentGitSha: () => 'abc123456789',
        async openDatabase(filename) {
            assert.equal(filename, dbPath);
            return { async close() { closed = true; } };
        },
        async buildBatch(db, options) {
            assert.ok(db);
            receivedOptions = options;
            return {
                write: false,
                queryOnlySafe: true,
                subjectCount: 1,
                criticalCount: 0,
                divergentCount: 0,
                reports: [],
            };
        },
    });
    assert.equal(closed, true);
    assert.deepEqual(receivedOptions.subjectIds, ['a@lid']);
    assert.deepEqual(receivedOptions.scopeKeys, ['lobos']);
    assert.equal(report.database.unchanged, true);
    assert.equal(report.queryOnlySafe, true);
    assert.equal(fs.existsSync(outputPath), true);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
    }
    assert.equal(fs.readFileSync(dbPath, 'utf8'), 'snapshot-imutavel');
});

test('auditoria falha quando o banco muda durante a leitura', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-shadow-change-'));
    const dbPath = path.join(directory, 'snapshot.sqlite');
    fs.writeFileSync(dbPath, 'antes');
    await assert.rejects(() => runShadowAudit({
        db: dbPath,
        output: null,
        subjectIds: [],
        scopeKeys: [],
        referenceDate: null,
        expectedAuditorSha: null,
    }, {
        currentGitSha: () => 'abc',
        async openDatabase() { return { async close() {} }; },
        async buildBatch() {
            fs.appendFileSync(dbPath, '-depois');
            return { queryOnlySafe: true, subjectCount: 0, criticalCount: 0, divergentCount: 0, reports: [] };
        },
    }), { code: 'shadow_audit_database_changed' });
});

test('auditoria bloqueia SHA inesperado antes de abrir o banco', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-shadow-sha-'));
    const dbPath = path.join(directory, 'snapshot.sqlite');
    fs.writeFileSync(dbPath, 'snapshot');
    let opened = false;
    await assert.rejects(() => runShadowAudit({
        db: dbPath,
        output: null,
        subjectIds: [],
        scopeKeys: [],
        referenceDate: null,
        expectedAuditorSha: 'expected',
    }, {
        currentGitSha: () => 'different',
        async openDatabase() { opened = true; return { async close() {} }; },
        async buildBatch() { return {}; },
    }), { code: 'auditor_sha_mismatch' });
    assert.equal(opened, false);
});
