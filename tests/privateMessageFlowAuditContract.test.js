'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    scanPrivateMessageFlows,
    writeAuditReport,
} = require('../helpers/clover/privateMessageFlowAudit');
const {
    decideExitCode,
    parseArgs,
} = require('../scripts/auditPrivateMessageFlows');

function makeTempRepository() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'clover-pv-audit-'));
}

function writeFixture(root, relativePath, content) {
    const absolute = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf8');
    return absolute;
}

test('classifica respostas, transações e contatos proativos separadamente', () => {
    const root = makeTempRepository();

    writeFixture(root, 'handlers/commandHandler.js', `
        async function handleCommandReply({ sock, idChat, m }) {
            await sendReply({ sock, idChat, m, text: 'ok' });
        }
    `);
    writeFixture(root, 'helpers/clover/appearanceApprovedService.js', `
        async function notifyAppearanceApproved(db, playerId) {
            return enqueuePrivateText(db, {
                targetJid: playerId,
                text: 'aparência aprovada',
                source: 'appearance_approved',
            });
        }
    `);
    writeFixture(root, 'helpers/clover/antiGhostService.js', `
        async function runAntiGhostSweep({ sock, player }) {
            return sendPrivateText({ sock, playerId: player.id, text: 'lembrete' });
        }
    `);

    const report = scanPrivateMessageFlows(root);
    const categories = new Map(report.findings.map((finding) => [finding.api, finding.category]));

    assert.equal(categories.get('sendReply'), 'reactive');
    assert.equal(categories.get('enqueuePrivateText'), 'transactional');
    assert.equal(categories.get('sendPrivateText'), 'proactive');
    assert.equal(report.write, false);
    assert.equal(report.summary.proactiveCount, 1);
});

test('marca socket direto e fluxo sem classificação para revisão', () => {
    const root = makeTempRepository();
    writeFixture(root, 'helpers/misc.js', `
        async function deliver(sock, target, content) {
            return sock.sendMessage(target, content);
        }
    `);

    const report = scanPrivateMessageFlows(root);
    assert.equal(report.summary.findingCount, 1);
    assert.equal(report.summary.directSocketCount, 1);
    assert.equal(report.summary.unknownCount, 1);
    assert.deepEqual(report.findings[0].riskFlags, [
        'classification_required',
        'direct_socket_send',
    ]);
});

test('detecta fila, retry e mais de três tentativas', () => {
    const root = makeTempRepository();
    writeFixture(root, 'helpers/clover/checklistService.js', `
        async function runWeeklyChecklistResetDispatch(db, player) {
            return enqueuePrivateText(db, {
                targetJid: player.id,
                text: 'semana resetada',
                source: 'weekly_checklist_reset',
                maxAttempts: 5,
            });
        }
    `);

    const report = scanPrivateMessageFlows(root);
    const finding = report.findings[0];
    assert.equal(finding.category, 'proactive');
    assert.equal(finding.trigger, 'scheduled');
    assert.ok(finding.riskFlags.includes('retry_or_queue'));
    assert.ok(finding.riskFlags.includes('automatic_schedule'));
    assert.ok(finding.riskFlags.includes('unsolicited_outreach'));
    assert.ok(finding.riskFlags.includes('more_than_three_attempts'));
});

test('ignora testes, artefatos, dependências e backups por padrão', () => {
    const root = makeTempRepository();
    writeFixture(root, 'index.js', 'sendPrivateText({ playerId: id, text: "x" });');
    writeFixture(root, 'tests/example.test.js', 'sendPrivateText({ playerId: id, text: "x" });');
    writeFixture(root, 'node_modules/pkg/index.js', 'sendPrivateText({ playerId: id, text: "x" });');
    writeFixture(root, 'artifacts/old/index.js', 'sendPrivateText({ playerId: id, text: "x" });');
    writeFixture(root, 'backup-runtime-old/index.js', 'sendPrivateText({ playerId: id, text: "x" });');

    const report = scanPrivateMessageFlows(root);
    assert.equal(report.summary.scannedFileCount, 1);
    assert.equal(report.summary.findingCount, 1);

    const withTests = scanPrivateMessageFlows(root, { includeTests: true });
    assert.equal(withTests.summary.scannedFileCount, 2);
    assert.equal(withTests.summary.findingCount, 2);
});

test('relatório é exclusivo e nunca sobrescreve evidência anterior', () => {
    const root = makeTempRepository();
    const output = path.join(root, 'private', 'report.json');
    const report = {
        version: 'test',
        write: false,
        summary: { findingCount: 0 },
        findings: [],
    };

    const written = writeAuditReport(report, output);
    assert.equal(written, path.resolve(output));
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), report);
    assert.throws(() => writeAuditReport(report, output), /EEXIST/);
});

test('CLI exige saída e mantém modos de falha opt-in', () => {
    assert.throws(() => parseArgs([]), /Informe --output/);

    const parsed = parseArgs([
        '--root=.',
        '--output=report.json',
        '--include-tests',
        '--fail-on-unknown',
        '--fail-on-proactive',
        '--fail-on-direct-socket',
    ]);

    assert.equal(parsed.includeTests, true);
    assert.equal(parsed.failOnUnknown, true);
    assert.equal(parsed.failOnProactive, true);
    assert.equal(parsed.failOnDirectSocket, true);

    const report = {
        summary: {
            unknownCount: 1,
            proactiveCount: 1,
            directSocketCount: 1,
        },
    };

    assert.equal(decideExitCode(report, parsed), 2);
    assert.equal(decideExitCode(report, {
        failOnUnknown: false,
        failOnProactive: false,
        failOnDirectSocket: false,
    }), 0);
});
