'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    analyzeBlankRows,
    isPlaceholderSignature,
    parseArgs,
    runAudit,
    sameSha,
    unwrapDefault,
} = require('../scripts/auditBlankPlayerIdentities');

const columns = [
    { name: 'id', dflt_value: null, pk: 1, notnull: 0 },
    { name: 'nome', dflt_value: null, pk: 0, notnull: 0 },
    { name: 'display_name', dflt_value: "'-'", pk: 0, notnull: 0 },
    { name: 'personagem_nome', dflt_value: "'-'", pk: 0, notnull: 0 },
    { name: 'canonical_player_id', dflt_value: 'NULL', pk: 0, notnull: 0 },
    { name: 'ficha_status', dflt_value: "'incompleta'", pk: 0, notnull: 0 },
    { name: 'jogo_status', dflt_value: "'bloqueado'", pk: 0, notnull: 0 },
    { name: 'esquadrao', dflt_value: "'-'", pk: 0, notnull: 0 },
    { name: 'is_shadow', dflt_value: '0', pk: 0, notnull: 0 },
    { name: 'identity_status', dflt_value: "'active'", pk: 0, notnull: 0 },
    { name: 'lifecycle_status', dflt_value: "'active'", pk: 0, notnull: 0 },
    { name: 'merged_into', dflt_value: 'NULL', pk: 0, notnull: 0 },
    { name: 'archived_at', dflt_value: 'NULL', pk: 0, notnull: 0 },
    { name: 'archive_reason', dflt_value: 'NULL', pk: 0, notnull: 0 },
    { name: 'dinheiro', dflt_value: '0', pk: 0, notnull: 0 },
    { name: 'historia', dflt_value: "'-'", pk: 0, notnull: 0 },
];

function placeholderRow(overrides = {}) {
    return {
        __rowid__: 48,
        id: null,
        nome: 'Cacador',
        display_name: 'Cacador',
        personagem_nome: '-',
        canonical_player_id: null,
        ficha_status: 'incompleta',
        jogo_status: 'bloqueado',
        esquadrao: '-',
        is_shadow: 0,
        identity_status: 'active',
        lifecycle_status: 'active',
        merged_into: null,
        archived_at: null,
        archive_reason: null,
        dinheiro: 0,
        historia: '-',
        ...overrides,
    };
}

test('parseArgs aceita proteção e modo fail-on-unsafe', () => {
    const options = parseArgs([
        '--db=/tmp/snapshot.sqlite',
        '--output', '/tmp/report.json',
        '--expected-auditor-sha=abc123',
        '--fail-on-unsafe',
        '--json-only',
    ]);
    assert.equal(options.db, '/tmp/snapshot.sqlite');
    assert.equal(options.output, '/tmp/report.json');
    assert.equal(options.expectedAuditorSha, 'abc123');
    assert.equal(options.failOnUnsafe, true);
    assert.equal(options.jsonOnly, true);
});

test('sameSha aceita apenas prefixo verdadeiro', () => {
    assert.equal(sameSha('abcdef1234', 'abcdef'), true);
    assert.equal(sameSha('abcdef', 'abcdef1234'), true);
    assert.equal(sameSha('abcdef', 'abc999'), false);
    assert.equal(sameSha(null, 'abc'), null);
});

test('unwrapDefault entende NULL, número e string SQL', () => {
    assert.deepEqual(unwrapDefault('NULL'), { known: true, value: null });
    assert.deepEqual(unwrapDefault('(0)'), { known: true, value: 0 });
    assert.deepEqual(unwrapDefault("'incompleta'"), { known: true, value: 'incompleta' });
    assert.deepEqual(unwrapDefault("'d''agua'"), { known: true, value: "d'agua" });
});

test('assinatura homogênea de Cacador é reconhecida sem dados substantivos', () => {
    const row = placeholderRow();
    assert.equal(isPlaceholderSignature(row), true);
    const [analysis] = analyzeBlankRows(columns, [row]);
    assert.equal(analysis.placeholderSignature, true);
    assert.equal(analysis.substantiveDeviationCount, 0);
    assert.deepEqual(analysis.substantiveDeviations, []);
});

test('conteúdo fora dos defaults impede limpeza automática', () => {
    const row = placeholderRow({ historia: 'Uma história real foi gravada aqui.' });
    const [analysis] = analyzeBlankRows(columns, [row]);
    assert.equal(analysis.placeholderSignature, true);
    assert.equal(analysis.substantiveDeviationCount, 1);
    assert.equal(analysis.substantiveDeviations[0].column, 'historia');
});

test('assinatura divergente é detectada mesmo sem campo substantivo', () => {
    const row = placeholderRow({ nome: 'Jogador desconhecido' });
    assert.equal(isPlaceholderSignature(row), false);
    const [analysis] = analyzeBlankRows(columns, [row]);
    assert.equal(analysis.placeholderSignature, false);
});

test('runAudit preserva snapshot, fecha conexão e não sobrescreve saída', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blank-identities-'));
    const dbPath = path.join(root, 'snapshot.sqlite');
    const outputPath = path.join(root, 'private', 'report.json');
    fs.writeFileSync(dbPath, 'snapshot-imutavel');
    let closed = false;
    const report = await runAudit({
        db: dbPath,
        output: outputPath,
        expectedAuditorSha: 'abc123',
        failOnUnsafe: false,
        jsonOnly: false,
    }, {
        currentGitSha: () => 'abc123456789',
        async openDatabase(filename) {
            assert.equal(filename, dbPath);
            return { async close() { closed = true; } };
        },
        async inspect() {
            return {
                write: false,
                queryOnlySafe: true,
                summary: {
                    blankIdentityCount: 10,
                    exactPlaceholderCount: 10,
                    critical: false,
                    reviewRequired: true,
                },
            };
        },
    });
    assert.equal(closed, true);
    assert.equal(report.database.unchanged, true);
    assert.equal(report.queryOnlySafe, true);
    assert.equal(fs.readFileSync(dbPath, 'utf8'), 'snapshot-imutavel');
    assert.equal(fs.existsSync(outputPath), true);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
    }
    await assert.rejects(() => runAudit({
        db: dbPath,
        output: outputPath,
        expectedAuditorSha: 'abc123',
        failOnUnsafe: false,
        jsonOnly: false,
    }, {
        currentGitSha: () => 'abc123456789',
        async openDatabase() { return { async close() {} }; },
        async inspect() {
            return { write: false, queryOnlySafe: true, summary: { reviewRequired: false } };
        },
    }), { code: 'EEXIST' });
});

test('runAudit bloqueia SHA incorreto antes de abrir o banco', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blank-identities-sha-'));
    const dbPath = path.join(root, 'snapshot.sqlite');
    fs.writeFileSync(dbPath, 'snapshot');
    let opened = false;
    await assert.rejects(() => runAudit({
        db: dbPath,
        output: null,
        expectedAuditorSha: 'expected',
        failOnUnsafe: false,
        jsonOnly: false,
    }, {
        currentGitSha: () => 'different',
        async openDatabase() {
            opened = true;
            return { async close() {} };
        },
    }), { code: 'auditor_sha_mismatch' });
    assert.equal(opened, false);
});

test('runAudit detecta mutação do snapshot durante a leitura', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blank-identities-change-'));
    const dbPath = path.join(root, 'snapshot.sqlite');
    fs.writeFileSync(dbPath, 'antes');
    await assert.rejects(() => runAudit({
        db: dbPath,
        output: null,
        expectedAuditorSha: null,
        failOnUnsafe: false,
        jsonOnly: false,
    }, {
        currentGitSha: () => 'abc',
        async openDatabase() { return { async close() {} }; },
        async inspect() {
            fs.appendFileSync(dbPath, '-depois');
            return { write: false, queryOnlySafe: true, summary: { reviewRequired: false } };
        },
    }), { code: 'blank_identity_audit_database_changed' });
});
