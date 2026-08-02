'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    parseArgs,
    runMembershipReadShadowAudit,
    sameSha,
} = require('../scripts/auditSquadMembershipReadShadow');

function safeShadow(overrides = {}) {
    return {
        write: false,
        queryOnlySafe: true,
        enforcementChanged: false,
        summary: {
            playerCount: 2,
            divergentPlayerCount: 0,
            changedSquadCount: 0,
            criticalCount: 0,
            safeToSwitchConsumers: true,
        },
        players: [],
        squads: [],
        ...overrides,
    };
}

test('parseArgs aceita proteção, saída e fail-on-unsafe', () => {
    const options = parseArgs([
        '--db=/tmp/source.sqlite',
        '--output', '/tmp/report.json',
        '--expected-auditor-sha=abc123',
        '--fail-on-unsafe',
        '--json-only',
    ]);
    assert.equal(options.db, '/tmp/source.sqlite');
    assert.equal(options.output, '/tmp/report.json');
    assert.equal(options.expectedAuditorSha, 'abc123');
    assert.equal(options.failOnUnsafe, true);
    assert.equal(options.jsonOnly, true);
});

test('sameSha aceita SHA curto por prefixo real', () => {
    assert.equal(sameSha('abcdef1234', 'abcdef'), true);
    assert.equal(sameSha('abcdef', 'abcdef1234'), true);
    assert.equal(sameSha('abcdef', 'abc999'), false);
    assert.equal(sameSha(null, 'abc'), null);
});

test('auditoria preserva banco, fecha DB e grava evidência privada', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'membership-shadow-'));
    const dbPath = path.join(directory, 'snapshot.sqlite');
    const outputPath = path.join(directory, 'evidence', 'shadow.json');
    fs.writeFileSync(dbPath, 'snapshot-imutavel');
    let closed = false;
    const report = await runMembershipReadShadowAudit({
        db: dbPath,
        output: outputPath,
        expectedAuditorSha: 'abc123',
    }, {
        currentGitSha: () => 'abc123456789',
        async openDatabase(filename) {
            assert.equal(filename, dbPath);
            return { async close() { closed = true; } };
        },
        async buildReport() { return safeShadow(); },
    });
    assert.equal(closed, true);
    assert.equal(report.database.unchanged, true);
    assert.equal(report.result.summary.safeToSwitchConsumers, true);
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(dbPath, 'utf8'), 'snapshot-imutavel');
});

test('auditoria preserva resultado inseguro sem fingir prontidão', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'membership-shadow-unsafe-'));
    const dbPath = path.join(directory, 'snapshot.sqlite');
    fs.writeFileSync(dbPath, 'snapshot');
    const report = await runMembershipReadShadowAudit({ db: dbPath }, {
        currentGitSha: () => 'abc',
        async openDatabase() { return { async close() {} }; },
        async buildReport() {
            return safeShadow({
                summary: {
                    playerCount: 2,
                    divergentPlayerCount: 1,
                    changedSquadCount: 1,
                    criticalCount: 1,
                    safeToSwitchConsumers: false,
                },
            });
        },
    });
    assert.equal(report.result.summary.safeToSwitchConsumers, false);
    assert.equal(report.result.summary.criticalCount, 1);
});

test('auditoria rejeita shadow sem garantias read-only', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'membership-shadow-contract-'));
    const dbPath = path.join(directory, 'snapshot.sqlite');
    fs.writeFileSync(dbPath, 'snapshot');
    await assert.rejects(() => runMembershipReadShadowAudit({ db: dbPath }, {
        currentGitSha: () => 'abc',
        async openDatabase() { return { async close() {} }; },
        async buildReport() { return safeShadow({ enforcementChanged: true }); },
    }), { code: 'membership_read_shadow_contract_invalid' });
});

test('auditoria falha quando o banco muda durante a leitura', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'membership-shadow-change-'));
    const dbPath = path.join(directory, 'snapshot.sqlite');
    fs.writeFileSync(dbPath, 'antes');
    await assert.rejects(() => runMembershipReadShadowAudit({ db: dbPath }, {
        currentGitSha: () => 'abc',
        async openDatabase() { return { async close() {} }; },
        async buildReport() {
            fs.appendFileSync(dbPath, '-depois');
            return safeShadow();
        },
    }), { code: 'membership_read_shadow_database_changed' });
});

test('auditoria bloqueia SHA inesperado antes de abrir o banco', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'membership-shadow-sha-'));
    const dbPath = path.join(directory, 'snapshot.sqlite');
    fs.writeFileSync(dbPath, 'snapshot');
    let opened = false;
    await assert.rejects(() => runMembershipReadShadowAudit({
        db: dbPath,
        expectedAuditorSha: 'expected',
    }, {
        currentGitSha: () => 'different',
        async openDatabase() { opened = true; return { async close() {} }; },
        async buildReport() { return safeShadow(); },
    }), { code: 'auditor_sha_mismatch' });
    assert.equal(opened, false);
});

test('evidência existente não é sobrescrita', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'membership-shadow-output-'));
    const dbPath = path.join(directory, 'snapshot.sqlite');
    const outputPath = path.join(directory, 'shadow.json');
    fs.writeFileSync(dbPath, 'snapshot');
    fs.writeFileSync(outputPath, 'evidencia-anterior');
    await assert.rejects(() => runMembershipReadShadowAudit({
        db: dbPath,
        output: outputPath,
    }, {
        currentGitSha: () => 'abc',
        async openDatabase() { return { async close() {} }; },
        async buildReport() { return safeShadow(); },
    }), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(outputPath, 'utf8'), 'evidencia-anterior');
});
