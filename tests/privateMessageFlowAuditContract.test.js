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

test('separa resposta de comando, transação e contato proativo', () => {
    const root = makeTempRepository();
    writeFixture(root, 'comandos/antighost.js', `
        async function executar({ sock, idChat, m }) {
            await sendReply({ sock, idChat, m, text: 'ok' });
        }
    `);
    writeFixture(root, 'helpers/clover/appearanceApprovedService.js', `
        async function notifyPlayerAppearanceResult(sock, playerId) {
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
    const byPath = new Map(report.findings.map((finding) => [finding.path, finding]));

    assert.equal(byPath.get('comandos/antighost.js').category, 'reactive');
    assert.equal(byPath.get('helpers/clover/appearanceApprovedService.js').category, 'transactional');
    assert.equal(byPath.get('helpers/clover/antiGhostService.js').category, 'proactive');
    assert.equal(report.summary.proactiveCount, 1);
});

test('não usa o nome do arquivo para transformar respostas em proativas', () => {
    const root = makeTempRepository();
    writeFixture(root, 'comandos/checklist.js', `
        function helperAntigo() { return 'weekly reminder'; }

        async function executar({ sock, idChat, m }) {
            return sendReply({ sock, idChat, m, text: 'checklist atual' });
        }
    `);

    const report = scanPrivateMessageFlows(root);
    assert.equal(report.findings[0].functionName, 'executar');
    assert.equal(report.findings[0].category, 'reactive');
    assert.equal(report.summary.proactiveCount, 0);
});

test('separa socket de grupo, bypass privado e transporte central', () => {
    const root = makeTempRepository();
    writeFixture(root, 'helpers/clover/archiveManager.js', `
        async function syncArchiveSnapshot({ sock, archiveGroupId }) {
            return sock.sendMessage(archiveGroupId, { text: 'card' });
        }
    `);
    writeFixture(root, 'helpers/clover/privateNotice.js', `
        async function sendNotice({ sock, playerId }) {
            return sock.sendMessage(playerId, { text: 'notice' });
        }
    `);
    writeFixture(root, 'helpers/chatReply.js', `
        async function sendMessageWithFallback(sock, target, message) {
            return sock.sendMessage(target, message);
        }
    `);

    const report = scanPrivateMessageFlows(root);
    const archive = report.findings.find((item) => item.path.includes('archiveManager'));
    const privateNotice = report.findings.find((item) => item.path.includes('privateNotice'));
    const transport = report.findings.find((item) => item.path === 'helpers/chatReply.js');

    assert.equal(archive.category, 'non_private');
    assert.ok(archive.riskFlags.includes('direct_group_socket_send'));
    assert.equal(privateNotice.channel, 'private');
    assert.ok(privateNotice.riskFlags.includes('direct_private_socket_bypass'));
    assert.equal(transport.category, 'infrastructure');
    assert.ok(transport.riskFlags.includes('transport_core'));
    assert.equal(report.summary.directPrivateSocketCount, 1);
});

test('classifica reação, mapa e resultado de job como reativos', () => {
    const root = makeTempRepository();
    writeFixture(root, 'helpers/clover/quickEvaluationService.js', `
        async function sendReactionToKey({ sock, idChat, key }) {
            return sock.sendMessage(idChat, { react: { text: 'ok', key } });
        }
    `);
    writeFixture(root, 'helpers/rpg/treeImages.js', `
        async function sendTreeMap({ sock, idChat }) {
            return sock.sendMessage(idChat, { text: 'mapa' });
        }
    `);
    writeFixture(root, 'helpers/clover/cloverScriptJobService.js', `
        async function notifyJobResult(sock, job, text) {
            return sock.sendMessage(job.chat_id, { text });
        }
    `);

    const report = scanPrivateMessageFlows(root);
    assert.equal(report.summary.unknownCount, 0);
    assert.ok(report.findings.every((item) => item.category === 'reactive'));
});

test('detecta fila proativa, retry e mais de três tentativas', () => {
    const root = makeTempRepository();
    writeFixture(root, 'helpers/clover/checklistService.js', `
        async function queueWeeklyNoticeForPlayer(db, player) {
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

test('ignora chamadas escritas dentro de strings e comentários', () => {
    const root = makeTempRepository();
    writeFixture(root, 'scripts/patch.js', `
        const patch = "sock.sendMessage(playerId, { text: 'x' })";
        // sendPrivateText({ playerId, text: 'x' });
        /* enqueuePrivateText(db, { targetJid: playerId, text: 'x' }); */
    `);

    const report = scanPrivateMessageFlows(root);
    assert.equal(report.summary.findingCount, 0);
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