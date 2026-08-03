'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'scripts', 'repairSiteIdentityAndEvaluationReceipt20260803.cjs');
const PATCH_MARKER = 'const originalUsesCrLf = original.includes';

function patchTargetScript(original) {
    if (original.includes(PATCH_MARKER)) {
        return { text: original, changed: false };
    }

    const functionStart = original.indexOf('function patchSiteAuth(original) {');
    const functionEnd = original.indexOf('\nfunction patchQuickEvaluation(original) {', functionStart);
    if (functionStart < 0 || functionEnd < 0) {
        throw new Error('Nao encontrei a funcao patchSiteAuth no reparo original.');
    }

    const before = original.slice(0, functionStart);
    let block = original.slice(functionStart, functionEnd);
    const after = original.slice(functionEnd);

    const startNeedle = [
        'function patchSiteAuth(original) {',
        '    let text = original;',
        '    let changed = false;',
    ].join('\n');
    const startReplacement = [
        'function patchSiteAuth(original) {',
        "    const originalUsesCrLf = original.includes('\\r\\n');",
        "    let text = original.replace(/\\r\\n/g, '\\n');",
        '    let changed = false;',
    ].join('\n');

    if (!block.includes(startNeedle)) {
        throw new Error('Nao encontrei o inicio esperado de patchSiteAuth.');
    }
    block = block.replace(startNeedle, startReplacement);

    const returnNeedle = '    return { text, changed };\n}';
    const returnReplacement = [
        "    if (originalUsesCrLf) text = text.replace(/\\n/g, '\\r\\n');",
        '    return { text, changed };',
        '}',
    ].join('\n');

    if (!block.includes(returnNeedle)) {
        throw new Error('Nao encontrei o retorno esperado de patchSiteAuth.');
    }
    block = block.replace(returnNeedle, returnReplacement);

    const text = before + block + after;
    if (!text.includes(PATCH_MARKER)) {
        throw new Error('A correcao de CRLF nao foi inserida.');
    }
    return { text, changed: true };
}

function syntaxCheck(filePath) {
    const result = spawnSync(process.execPath, ['--check', filePath], {
        cwd: ROOT,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
    });
    if (result.error || result.status !== 0) {
        throw new Error(result.error?.message || result.stderr || result.stdout || 'Erro de sintaxe desconhecido.');
    }
}

function runTarget(args) {
    const result = spawnSync(process.execPath, [TARGET, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = Number(result.status || 0);
}

function main() {
    if (!fs.existsSync(TARGET)) {
        throw new Error(`Reparo original nao encontrado: ${TARGET}`);
    }

    const original = fs.readFileSync(TARGET, 'utf8');
    const patched = patchTargetScript(original);
    if (patched.changed) {
        const backup = `${TARGET}.before-crlf-fix`;
        if (!fs.existsSync(backup)) fs.copyFileSync(TARGET, backup);
        fs.writeFileSync(TARGET, patched.text, 'utf8');
        try {
            syntaxCheck(TARGET);
        } catch (error) {
            fs.copyFileSync(backup, TARGET);
            throw error;
        }
        console.log('[repair-launcher] Compatibilidade CRLF instalada no reparo.');
    } else {
        console.log('[repair-launcher] Compatibilidade CRLF ja instalada.');
    }

    runTarget(process.argv.slice(2));
}

try {
    main();
} catch (error) {
    console.error('\nFALHA NO LANCADOR DO REPARO:');
    console.error(error?.stack || error);
    process.exitCode = 1;
}
