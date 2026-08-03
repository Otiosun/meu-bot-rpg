'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'index.js');
const BACKUP_DIR = path.join(ROOT, 'backups');
const CONFIRMATION = 'RESTRINGIR-COMANDOS-PV-2026-08-03';
const PATCH_MARKER = 'const privateSiteAllowed = privateResolved?.command?.nome === `${COMMAND_PREFIX}site`;';

function parseArgs(argv) {
    const apply = argv.includes('--apply');
    const confirmationArg = argv.find((arg) => arg.startsWith('--confirm='));
    const confirmation = confirmationArg ? confirmationArg.slice('--confirm='.length) : null;
    if (apply && confirmation !== CONFIRMATION) {
        throw new Error(`Aplicação bloqueada. Use --apply --confirm=${CONFIRMATION}`);
    }
    return { apply };
}

function timestamp() {
    return new Date().toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, '');
}

function buildPatchedIndex(original) {
    if (original.includes(PATCH_MARKER)) {
        return { text: original, alreadyPatched: true };
    }

    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const pattern = /        if \(!isGroup && texto\) \{\r?\n            const exitReply = await handleExitConfirmationReply\(\{[\s\S]*?\r?\n            if \(antiGhostReply\.handled\) \{\r?\n                return;\r?\n            \}\r?\n        \}/;
    const match = original.match(pattern);
    if (!match) {
        throw new Error('Não encontrei o bloco privado atual de saída/anti-ghost. Nada foi alterado.');
    }

    const replacement = [
        '        if (!isGroup) {',
        "            const privateText = String(texto || '').trim();",
        '',
        '            // A confirmação de saída precisa continuar aceitando a resposta do jogador no PV.',
        '            if (privateText) {',
        '                const exitReply = await handleExitConfirmationReply({',
        '                    sock,',
        '                    db,',
        '                    playerId: rawIdJogador,',
        '                    text: privateText,',
        '                });',
        '                if (exitReply.handled) {',
        '                    return;',
        '                }',
        '            }',
        '',
        '            // Fora da confirmação de saída, somente o comando canônico .#site',
        '            // e seus aliases podem ser executados no privado.',
        '            const privateResolved = privateText.startsWith(COMMAND_PREFIX)',
        '                ? resolveCommand(privateText, comandos)',
        '                : null;',
        '            const privateSiteAllowed = privateResolved?.command?.nome === `${COMMAND_PREFIX}site`;',
        '            if (!privateSiteAllowed) {',
        "                console.log('[pv-command] entrada privada ignorada; use o grupo de comandos:', {",
        '                    idChat,',
        '                    command: privateResolved?.matchedName || (privateText.startsWith(COMMAND_PREFIX)',
        '                        ? privateText.slice(0, 80)',
        '                        : null),',
        '                });',
        '                return;',
        '            }',
        '        }',
    ].join(eol);

    const text = original.replace(pattern, replacement);
    if (!text.includes(PATCH_MARKER)) {
        throw new Error('Patch incompleto: marcador final ausente.');
    }
    if (!text.includes('const exitReply = await handleExitConfirmationReply({')) {
        throw new Error('Patch inválido: confirmação de saída foi perdida.');
    }
    return { text, alreadyPatched: false };
}

function checkSyntax() {
    const result = spawnSync(process.execPath, ['--check', INDEX_PATH], {
        cwd: ROOT,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
    });
    if (result.status !== 0 || result.error) {
        throw new Error(result.error?.message || result.stderr || result.stdout || 'Falha de sintaxe desconhecida.');
    }
}

function main() {
    const { apply } = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(INDEX_PATH)) throw new Error(`index.js não encontrado: ${INDEX_PATH}`);

    const original = fs.readFileSync(INDEX_PATH, 'utf8');
    const patched = buildPatchedIndex(original);

    console.log('============================================================');
    console.log('RESTRIÇÃO DE COMANDOS NO PV');
    console.log('============================================================');
    console.log('Permitido no PV: .#site e aliases');
    console.log('Permitido no PV: resposta à confirmação de saída');
    console.log('Bloqueado no PV: perfil, PH, inventário, status e demais comandos');
    console.log('Bloqueado no PV: ficha, magia, imagem e texto avulso');
    console.log('Avisos transacionais automáticos: não são alterados');
    console.log(`Estado: ${patched.alreadyPatched ? 'já instalado' : 'pronto para instalar'}`);
    console.log('============================================================');

    if (!apply) {
        console.log('PREVIEW CONCLUÍDO. Nenhuma alteração foi realizada.');
        return;
    }

    if (patched.alreadyPatched) {
        checkSyntax();
        console.log('APLICAÇÃO CONCLUÍDA. O bloqueio já estava instalado e a sintaxe está válida.');
        return;
    }

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backupPath = path.join(BACKUP_DIR, `index.before-private-command-gate-${timestamp()}.js`);
    fs.copyFileSync(INDEX_PATH, backupPath);
    fs.writeFileSync(INDEX_PATH, patched.text, 'utf8');

    try {
        checkSyntax();
    } catch (error) {
        fs.copyFileSync(backupPath, INDEX_PATH);
        throw new Error(`Patch revertido por erro de sintaxe: ${error.message}`);
    }

    console.log('============================================================');
    console.log('APLICAÇÃO CONCLUÍDA');
    console.log(`Backup: ${backupPath}`);
    console.log('PV: somente .#site e confirmação de saída permanecem interativos');
    console.log('Avisos automáticos transacionais: preservados');
    console.log('============================================================');
}

try {
    main();
} catch (error) {
    console.error(`FALHA: ${error?.stack || error}`);
    process.exitCode = 1;
}
