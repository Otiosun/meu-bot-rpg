'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../helpers/clover/squadMembershipIntegrityAudit') {
        return { buildSquadMembershipIntegrityReport: async () => ({ summary: { criticalCount: 0 } }) };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const script = require('../scripts/auditSquadMembershipIntegrity');
Module._load = originalLoad;

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'clover-membership-audit-'));
}

function fakeDb() {
    return {
        closed: false,
        async exec(sql) { assert.equal(sql, 'PRAGMA query_only=ON'); },
        async get(sql) { assert.equal(sql, 'PRAGMA query_only'); return { query_only: 1 }; },
        async close() { this.closed = true; },
    };
}

test('parseia argumentos principais', () => {
    assert.deepEqual(script.parseArgs([
        '--db=x.sqlite', '--output', 'out.json', '--expected-auditor-sha=abc',
        '--runtime-sha', 'def', '--fail-on-critical', '--json-only',
    ]), {
        db: 'x.sqlite', output: 'out.json', expectedAuditorSha: 'abc', runtimeSha: 'def',
        failOnCritical: true, jsonOnly: true,
    });
});

test('aceita SHA curto ou completo', () => {
    assert.equal(script.sameSha('abcdef1234', 'abcdef1'), true);
    assert.equal(script.sameSha('abcdef1', 'abcdef1234'), true);
    assert.equal(script.sameSha('abc', 'def'), false);
});

test('audita snapshot sem alterar bytes e grava relatório 0600', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'snapshot.sqlite');
    const output = path.join(dir, 'report.json');
    fs.writeFileSync(dbPath, 'immutable database');
    const db = fakeDb();
    const evidence = await script.runAudit({
        db: dbPath, output, expectedAuditorSha: 'abc123', runtimeSha: 'runtime',
    }, {
        gitSha: () => 'abc123456',
        openReadOnly: async () => db,
        reportBuilder: async () => ({
            write: false, queryOnlySafe: true,
            summary: { criticalCount: 0, warningCount: 1, canAdvance: true },
        }),
    });
    assert.equal(evidence.database.immutable, true);
    assert.equal(db.closed, true);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).kind, 'clover.squad-membership-integrity.v1');
});

test('detecta alteração do snapshot durante leitura', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'snapshot.sqlite');
    fs.writeFileSync(dbPath, 'before');
    await assert.rejects(() => script.runAudit({ db: dbPath }, {
        gitSha: () => 'abc',
        openReadOnly: async () => fakeDb(),
        reportBuilder: async () => {
            fs.appendFileSync(dbPath, 'after');
            return { summary: { criticalCount: 0 } };
        },
    }), (error) => error.code === 'membership_audit_database_changed');
});

test('SHA incorreto bloqueia antes de abrir o banco', async () => {
    let opened = false;
    await assert.rejects(() => script.runAudit({ db: '/does/not/matter', expectedAuditorSha: 'expected' }, {
        gitSha: () => 'actual',
        openReadOnly: async () => { opened = true; return fakeDb(); },
    }), (error) => error.code === 'membership_audit_sha_mismatch');
    assert.equal(opened, false);
});

test('não sobrescreve evidência existente', async () => {
    const dir = tempDir();
    const output = path.join(dir, 'report.json');
    fs.writeFileSync(output, '{}');
    assert.throws(() => script.assertOutputAvailable(output), (error) => error.code === 'membership_audit_output_exists');
});

test('query_only não confirmado encerra a conexão', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'snapshot.sqlite');
    fs.writeFileSync(dbPath, 'db');
    const db = fakeDb();
    db.get = async () => ({ query_only: 0 });
    await assert.rejects(() => script.runAudit({ db: dbPath }, {
        gitSha: () => 'abc', openReadOnly: async () => db,
    }), (error) => error.code === 'membership_audit_query_only_failed');
    assert.equal(db.closed, true);
});
