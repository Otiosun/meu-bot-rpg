'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'helpers', 'chatReply.js');
const LEGACY_INTEGRATOR = path.join(ROOT, 'scripts', 'integratePrivateMessagePolicyRuntime.js');
const EXPECTED_CANONICAL_BLOB_SHA = '51a6c3e1a969dd716023df0676f08ee949003397';
const INTEGRATION_MARKER = "require('./clover/privateMessagePolicyRuntime')";

function gitBlobSha(content) {
    const body = Buffer.from(content, 'utf8');
    const header = Buffer.from(`blob ${body.length}\0`, 'utf8');
    return crypto.createHash('sha1').update(header).update(body).digest('hex');
}

function normalizeLf(content) {
    return String(content || '').replace(/\r\n/g, '\n');
}

function restoreEol(content, eol) {
    const normalized = normalizeLf(content);
    return eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

function runLegacyApply() {
    const result = spawnSync(process.execPath, [LEGACY_INTEGRATOR, '--apply'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`Integrador base terminou com código ${result.status}.`);
    }
}

function main() {
    const args = new Set(process.argv.slice(2));
    const apply = args.has('--apply');
    const check = args.has('--check') || !apply;

    const rawOriginal = fs.readFileSync(TARGET, 'utf8');
    const originalEol = rawOriginal.includes('\r\n') ? '\r\n' : '\n';
    const canonicalOriginal = normalizeLf(rawOriginal);

    if (canonicalOriginal.includes(INTEGRATION_MARKER)) {
        console.log('[pv-policy-portable] integração já aplicada.');
        return;
    }

    const canonicalBlobSha = gitBlobSha(canonicalOriginal);
    if (canonicalBlobSha !== EXPECTED_CANONICAL_BLOB_SHA) {
        throw new Error(
            `chatReply.js divergiu de verdade. Esperado ${EXPECTED_CANONICAL_BLOB_SHA}; `
            + `canônico atual ${canonicalBlobSha}. Revisão manual obrigatória.`
        );
    }

    console.log('[pv-policy-portable] conteúdo canônico aprovado.');
    console.log(`[pv-policy-portable] EOL detectado: ${originalEol === '\r\n' ? 'CRLF' : 'LF'}`);
    console.log(`[pv-policy-portable] blob canônico: ${canonicalBlobSha}`);

    if (check) {
        console.log('[pv-policy-portable] check concluído; nenhum arquivo alterado.');
    }

    if (!apply) return;

    let applied = false;
    try {
        fs.writeFileSync(TARGET, canonicalOriginal, 'utf8');
        runLegacyApply();
        applied = true;

        const integratedRaw = fs.readFileSync(TARGET, 'utf8');
        fs.writeFileSync(TARGET, restoreEol(integratedRaw, originalEol), 'utf8');

        console.log('[pv-policy-portable] integração aplicada com EOL preservado.');
    } finally {
        if (!applied) {
            fs.writeFileSync(TARGET, rawOriginal, 'utf8');
            console.error('[pv-policy-portable] falha detectada; chatReply.js restaurado integralmente.');
        }
    }
}

try {
    main();
} catch (error) {
    console.error(`[pv-policy-portable] falha: ${error?.message || error}`);
    process.exitCode = 1;
}
