'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'index.js');
const CONTRACT_PATH = path.join(ROOT, 'tests', 'privateDeliveryRuntimeIndexContract.test.js');
const CONTRACT_TEMPLATE_PATH = path.join(
    ROOT,
    'scripts',
    'templates',
    'privateDeliveryRuntimeIndexContract.test.js.txt'
);
const EXPECTED_INDEX_BLOB = '1c57001626cf040d6800d111eb603249f3259372';

function normalizeLf(content) {
    return String(content || '').replace(/\r\n/g, '\n');
}

function restoreEol(content, eol) {
    const normalized = normalizeLf(content);
    return eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

function gitBlobSha(content) {
    const body = Buffer.from(content, 'utf8');
    const header = Buffer.from(`blob ${body.length}\0`, 'utf8');
    return crypto.createHash('sha1').update(header).update(body).digest('hex');
}

function countOccurrences(content, needle) {
    return content.split(needle).length - 1;
}

function replaceExactly(content, before, after, label) {
    if (content.includes(after) && !content.includes(before)) return content;
    const count = countOccurrences(content, before);
    if (count !== 1) {
        throw new Error(`${label}: esperado 1 trecho original, encontrado ${count}.`);
    }
    return content.replace(before, after);
}

function buildIntegratedIndex(content) {
    let next = content;
    next = replaceExactly(
        next,
        "const { handlePrivateSendUpdate, sendReaction, sendReply } = require('./helpers/chatReply');",
        "const { handlePrivateSendUpdate, sendReaction, sendReply } = require('./helpers/chatReply');\nconst { runPrivateDeliveryWorkerOnce } = require('./helpers/clover/privateDeliveryRuntimeHook');",
        'runtime.import'
    );

    const beforeOpenTasks = "            try {\n                const offApproval = await approvePendingOffGroupRequests(sock, db);";
    const afterOpenTasks = "            try {\n                const privateDeliveryResult = await runPrivateDeliveryWorkerOnce({\n                    sock,\n                    db,\n                    env: process.env,\n                    context: 'connection_open',\n                });\n                if (\n                    !privateDeliveryResult?.skipped\n                    || !['worker_disabled', 'run_on_open_disabled'].includes(privateDeliveryResult?.reason)\n                ) {\n                    console.log('[pv-delivery] execucao controlada:', {\n                        ok: privateDeliveryResult?.ok ?? null,\n                        skipped: privateDeliveryResult?.skipped ?? false,\n                        reason: privateDeliveryResult?.reason || null,\n                        jobId: privateDeliveryResult?.jobId || null,\n                        status: privateDeliveryResult?.status || null,\n                        sent: privateDeliveryResult?.sent === true,\n                    });\n                }\n            } catch (error) {\n                console.log('[pv-delivery] falha na execucao controlada:', error?.message || error);\n            }\n\n            try {\n                const offApproval = await approvePendingOffGroupRequests(sock, db);";
    next = replaceExactly(next, beforeOpenTasks, afterOpenTasks, 'runtime.connection_open');
    return next;
}

function prepare() {
    const raw = fs.readFileSync(INDEX_PATH, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const normalized = normalizeLf(raw);
    const blob = gitBlobSha(normalized);
    if (blob !== EXPECTED_INDEX_BLOB) {
        throw new Error(
            `index.js divergiu. Esperado ${EXPECTED_INDEX_BLOB}; atual ${blob}. `
            + 'Rebase ou revisao manual obrigatoria.'
        );
    }

    const integrated = buildIntegratedIndex(normalized);
    const contract = fs.readFileSync(CONTRACT_TEMPLATE_PATH, 'utf8');
    return {
        raw,
        eol,
        integrated: restoreEol(integrated, eol),
        contract: restoreEol(contract, eol),
        originalBlob: blob,
        integratedBlob: gitBlobSha(integrated),
    };
}

function applyPrepared(prepared) {
    const originalContract = fs.existsSync(CONTRACT_PATH)
        ? fs.readFileSync(CONTRACT_PATH)
        : null;
    try {
        fs.writeFileSync(INDEX_PATH, prepared.integrated, 'utf8');
        fs.writeFileSync(CONTRACT_PATH, prepared.contract, 'utf8');
    } catch (error) {
        fs.writeFileSync(INDEX_PATH, prepared.raw, 'utf8');
        if (originalContract === null) fs.rmSync(CONTRACT_PATH, { force: true });
        else fs.writeFileSync(CONTRACT_PATH, originalContract);
        throw error;
    }
}

function main() {
    const mode = process.argv.includes('--apply') ? 'apply' : 'check';
    const prepared = prepare();
    console.log('[pv-delivery-runtime] pre-condicoes aprovadas.');
    console.log('[pv-delivery-runtime] EOL:', prepared.eol === '\r\n' ? 'CRLF' : 'LF');
    console.log('[pv-delivery-runtime] blob original:', prepared.originalBlob);
    console.log('[pv-delivery-runtime] blob integrado:', prepared.integratedBlob);

    if (mode === 'check') {
        console.log('[pv-delivery-runtime] check concluido; nenhum arquivo alterado.');
        return;
    }

    applyPrepared(prepared);
    console.log('[pv-delivery-runtime] index.js atualizado.');
    console.log('[pv-delivery-runtime] contrato permanente criado.');
}

try {
    main();
} catch (error) {
    console.error('[pv-delivery-runtime] falha:', error?.message || error);
    process.exitCode = 1;
}
