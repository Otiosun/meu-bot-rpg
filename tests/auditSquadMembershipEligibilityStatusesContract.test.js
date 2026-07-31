'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    parseArgs,
    runEligibilityStatusAudit,
    scanStatusCallsites,
} = require('../scripts/auditSquadMembershipEligibilityStatuses');

function inventory(overrides = {}) {
    return {
        write: false,
        queryOnlySafe: true,
        policyApplied: false,
        policy: { evaluated: false, safeForExistingMembers: false },
        summary: {
            playerCount: 1,
            existingMemberCount: 0,
            candidateCount: 1,
            existingMemberFailureCount: 0,
        },
        ...overrides,
    };
}

test('parseArgs aceita allowlists repetidas e proteções', () => {
    const options = parseArgs([
        '--db=/tmp/db.sqlite', '--output=/tmp/out.json', '--root=/tmp/repo',
        '--approved-sheet-status=aprovada', '--approved-sheet-status', 'aprovado',
        '--released-game-status=liberado', '--released-game-status', 'liberada',
        '--expected-auditor-sha=abc', '--fail-on-policy-risk', '--json-only',
    ]);
    assert.deepEqual(options.approvedSheetStatuses, ['aprovada', 'aprovado']);
    assert.deepEqual(options.releasedGameStatuses, ['liberado', 'liberada']);
    assert.equal(options.failOnPolicyRisk, true);
});

test('scanner encontra uso dos status sem executar código', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-scan-'));
    fs.writeFileSync(path.join(root, 'service.js'), "const value = row.ficha_status;\nconst other = row.jogo_status;\n");
    const findings = scanStatusCallsites(root);
    assert.equal(findings.length, 2);
    assert.deepEqual(findings[0].matchedTerms, ['ficha_status']);
});

test('runner preserva banco, fecha conexão e grava relatório privado', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-run-'));
    const dbPath = path.join(root, 'snapshot.sqlite');
    const outputPath = path.join(root, 'private', 'report.json');
    fs.writeFileSync(dbPath, 'snapshot');
    let closed = false;
    let received = null;
    const report = await runEligibilityStatusAudit({
        db: dbPath,
        output: outputPath,
        root,
        approvedSheetStatuses: ['aprovada'],
        releasedGameStatuses: ['liberado'],
        expectedAuditorSha: 'abc',
    }, {
        currentGitSha: () => 'abcdef',
        async openDatabase() { return { async close() { closed = true; } }; },
        async buildAudit(db, options) { received = options; return inventory(); },
        scanCallsites: () => [{ path: 'x.js', line: 1 }],
    });
    assert.equal(closed, true);
    assert.deepEqual(received.approvedSheetStatuses, ['aprovada']);
    assert.equal(report.database.unchanged, true);
    assert.equal(report.codeUsage.length, 1);
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
});

test('runner rejeita contrato que afirma aplicação de política', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-contract-'));
    const dbPath = path.join(root, 'snapshot.sqlite');
    fs.writeFileSync(dbPath, 'snapshot');
    await assert.rejects(() => runEligibilityStatusAudit({ db: dbPath, root }, {
        currentGitSha: () => 'abc',
        async openDatabase() { return { async close() {} }; },
        async buildAudit() { return inventory({ policyApplied: true }); },
        scanCallsites: () => [],
    }), { code: 'eligibility_status_audit_contract_invalid' });
});

test('runner detecta alteração do snapshot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-change-'));
    const dbPath = path.join(root, 'snapshot.sqlite');
    fs.writeFileSync(dbPath, 'antes');
    await assert.rejects(() => runEligibilityStatusAudit({ db: dbPath, root }, {
        currentGitSha: () => 'abc',
        async openDatabase() { return { async close() {} }; },
        async buildAudit() { fs.appendFileSync(dbPath, '-depois'); return inventory(); },
        scanCallsites: () => [],
    }), { code: 'eligibility_status_audit_database_changed' });
});

test('runner bloqueia SHA inesperado antes de abrir o DB', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-sha-'));
    const dbPath = path.join(root, 'snapshot.sqlite');
    fs.writeFileSync(dbPath, 'snapshot');
    let opened = false;
    await assert.rejects(() => runEligibilityStatusAudit({
        db: dbPath, root, expectedAuditorSha: 'expected',
    }, {
        currentGitSha: () => 'different',
        async openDatabase() { opened = true; return { async close() {} }; },
        async buildAudit() { return inventory(); },
        scanCallsites: () => [],
    }), { code: 'auditor_sha_mismatch' });
    assert.equal(opened, false);
});

test('relatório existente não é sobrescrito', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-output-'));
    const dbPath = path.join(root, 'snapshot.sqlite');
    const outputPath = path.join(root, 'report.json');
    fs.writeFileSync(dbPath, 'snapshot');
    fs.writeFileSync(outputPath, 'anterior');
    await assert.rejects(() => runEligibilityStatusAudit({ db: dbPath, root, output: outputPath }, {
        currentGitSha: () => 'abc',
        async openDatabase() { return { async close() {} }; },
        async buildAudit() { return inventory(); },
        scanCallsites: () => [],
    }), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(outputPath, 'utf8'), 'anterior');
});
