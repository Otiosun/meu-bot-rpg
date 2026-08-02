'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    scanPrivateMessageFlows,
} = require('../helpers/clover/privateMessageFlowAudit');

function makeTempRepository() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'clover-pv-declaration-audit-'));
}

test('não contabiliza declarações das funções de envio como chamadas', () => {
    const root = makeTempRepository();
    const filePath = path.join(root, 'helpers', 'chatReply.js');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `
        async function sendReply({ sock, idChat, text }) {
            return text;
        }

        function sendPrivateText({ sock, playerId, text }) {
            return text;
        }

        async function useReply({ sock, idChat, m }) {
            return sendReply({ sock, idChat, m, text: 'ok' });
        }
    `, 'utf8');

    const report = scanPrivateMessageFlows(root);
    assert.equal(report.summary.findingCount, 1);
    assert.equal(report.findings[0].api, 'sendReply');
    assert.equal(report.findings[0].functionName, 'useReply');
});
