'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const REPO_ROOT = path.resolve(__dirname, '..');
const DATABASE_FILE = path.join(REPO_ROOT, 'banco.sqlite');
const MANIFEST_FILE = path.join(REPO_ROOT, 'data', 'player-canonical-batch-1-import.json');
const OUTPUT_DIR = path.join(REPO_ROOT, 'backups');
const PLAYER_ID = '119516088528998@lid';
const SOURCE = 'admin_whatsapp_2026-07-20';
const REPAIR_CONFIRMATION = 'REPAIR_VITOR_ACCESS_REGRESSION';
const IMPORT_CONFIRMATION = 'IMPORT_CANONICAL_PLAYER_CONTENT_BATCH1';
const PM2_COMMAND = process.platform === 'win32' ? 'pm2.cmd' : 'pm2';

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function quoteCmdArgument(value) {
    const text = String(value ?? '');
    if (!text) return '""';
    if (!/[\s"&|<>^()]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
}

function resolveCommandInvocation(command, args = [], platform = process.platform, env = process.env) {
    const normalizedArgs = [...args].map((arg) => String(arg));
    if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(String(command))) {
        return { command, args: normalizedArgs };
    }

    const commandProcessor = env.ComSpec || env.COMSPEC || 'cmd.exe';
    const commandLine = [command, ...normalizedArgs]
        .map(quoteCmdArgument)
        .join(' ');

    return {
        command: commandProcessor,
        args: ['/d', '/s', '/c', commandLine],
    };
}

function spawnResolved(command, args, options) {
    const invocation = resolveCommandInvocation(command, args);
    return spawnSync(invocation.command, invocation.args, options);
}

function runCapture(command, args = []) {
    const result = spawnResolved(command, args, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        windowsHide: true,
    });

    if (result.error) throw result.error;
    if (result.status !== 0) {
        const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        throw new Error(`${command} terminou com código ${result.status}.${detail ? `\n${detail}` : ''}`);
    }

    return String(result.stdout || '').trim();
}

function runChecked(command, args, failureMessage) {
    const result = spawnResolved(command, args, {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        windowsHide: false,
    });

    if (result.error) {
        throw new Error(`${failureMessage}\n${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`${failureMessage} Código: ${result.status}.`);
    }
}

function assertRepositoryReady() {
    const branch = runCapture('git', ['branch', '--show-current']);
    if (branch !== 'main') {
        throw new Error(`O projeto precisa estar na branch main. Branch atual: ${branch || '-'}.`);
    }

    const trackedChanges = runCapture('git', ['status', '--porcelain', '--untracked-files=no']);
    if (trackedChanges) {
        throw new Error(`Existem alterações rastreadas no projeto:\n${trackedChanges}`);
    }

    for (const requiredFile of [
        DATABASE_FILE,
        MANIFEST_FILE,
        path.join(REPO_ROOT, 'scripts', 'repairVitorAccessRegression.js'),
        path.join(REPO_ROOT, 'scripts', 'importCanonicalPlayerContentBatch1.js'),
    ]) {
        if (!fs.existsSync(requiredFile)) {
            throw new Error(`Arquivo obrigatório não encontrado: ${requiredFile}`);
        }
    }
}

function getCloverHealth() {
    return new Promise((resolve) => {
        const request = http.get('http://127.0.0.1:8787/health', (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                body += chunk;
            });
            response.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch {
                    resolve(null);
                }
            });
        });

        request.setTimeout(5000, () => request.destroy(new Error('timeout')));
        request.on('error', () => resolve(null));
    });
}

function isQueueIdle(health) {
    return Boolean(health?.ok)
        && Number(health?.queue?.depth || 0) === 0
        && !Boolean(health?.queue?.active);
}

async function waitForQueueIdle() {
    console.log('\n=== AGUARDANDO FILA DO CLOVER ===');

    for (let attempt = 1; attempt <= 30; attempt += 1) {
        const health = await getCloverHealth();
        if (health) {
            const depth = Number(health?.queue?.depth || 0);
            const active = Boolean(health?.queue?.active);
            console.log(`Tentativa ${attempt}: online=${Boolean(health.ok)} depth=${depth} active=${active}`);
            if (isQueueIdle(health)) return health;
        }
        await delay(2000);
    }

    throw new Error('A fila do Clover não ficou livre. Nada foi alterado.');
}

async function waitForCloverOnline() {
    console.log('\n=== AGUARDANDO HEALTH DO CLOVER ===');

    for (let attempt = 1; attempt <= 30; attempt += 1) {
        await delay(2000);
        const health = await getCloverHealth();
        if (health?.ok) {
            console.log(JSON.stringify(health, null, 2));
            return health;
        }
    }

    throw new Error('O Clover não respondeu ao health após o reinício.');
}

function assertExpectedCounts({ totals, overall, vitor, pending, linked }) {
    const byType = Object.fromEntries(
        totals.map((row) => [row.content_type, Number(row.total)])
    );
    const expected = {
        system_trait: 9,
        custom_trait: 7,
        narrative_hook: 4,
        narrative_item: 2,
    };

    if (Number(overall.total) !== 22) {
        throw new Error(`Total canônico inesperado: ${overall.total}/22`);
    }

    for (const [type, total] of Object.entries(expected)) {
        if (Number(byType[type] || 0) !== total) {
            throw new Error(`${type}: ${byType[type] || 0}/${total}`);
        }
    }

    if (vitor.length !== 2) {
        throw new Error(`Vitor possui ${vitor.length}/2 registros.`);
    }

    const vitorKeys = new Set(vitor.map((row) => `${row.content_type}:${row.content_key}`));
    if (!vitorKeys.has('system_trait:cria_da_fronteira')) {
        throw new Error('Cria da Fronteira ausente.');
    }
    if (!vitorKeys.has('narrative_hook:divida_da_montanha')) {
        throw new Error('Dívida da Montanha ausente.');
    }
    if (Number(pending.total) !== 7) {
        throw new Error(`Pendentes: ${pending.total}/7`);
    }
    if (Number(linked.total) !== 2) {
        throw new Error(`Itens vinculados: ${linked.total}/2`);
    }
}

async function verifyFinalState() {
    console.log('\n=== VERIFICAÇÃO FINAL SOMENTE LEITURA ===');

    const db = await open({
        filename: DATABASE_FILE,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });

    try {
        await db.exec('PRAGMA query_only = ON');

        const player = await db.get(
            `SELECT personagem_nome, ficha_status, personagem_aparencia_status,
                    historia_status, jogo_status, jogo_liberado_at,
                    jogo_liberado_by, jogo_bloqueio_motivo
             FROM jogadores
             WHERE id = ?`,
            [PLAYER_ID]
        );

        const totals = await db.all(
            `SELECT content_type, COUNT(*) AS total
             FROM clover_player_content
             WHERE active = 1 AND source = ?
             GROUP BY content_type
             ORDER BY content_type`,
            [SOURCE]
        );

        const overall = await db.get(
            `SELECT COUNT(*) AS total
             FROM clover_player_content
             WHERE active = 1 AND source = ?`,
            [SOURCE]
        );

        const vitor = await db.all(
            `SELECT content_type, content_key, title, mechanical_status, review_status
             FROM clover_player_content
             WHERE active = 1 AND source = ? AND player_id = ?
             ORDER BY content_type, content_key`,
            [SOURCE, PLAYER_ID]
        );

        const pending = await db.get(
            `SELECT COUNT(*) AS total
             FROM clover_player_content
             WHERE active = 1 AND source = ?
               AND content_type = 'custom_trait'
               AND mechanical_status = 'pending_balance'`,
            [SOURCE]
        );

        const linked = await db.get(
            `SELECT COUNT(*) AS total
             FROM clover_player_content
             WHERE active = 1 AND source = ?
               AND content_type = 'narrative_item'
               AND linked_content_id IS NOT NULL`,
            [SOURCE]
        );

        console.log('Vitor:', player);
        console.table(totals);
        console.log('Total canônico:', overall.total);
        console.log('Registros de Vitor:', vitor.length);
        console.table(vitor);
        console.log('Traços pendentes de balanceamento:', pending.total);
        console.log('Itens vinculados:', linked.total);

        if (!player || player.personagem_nome !== 'Vitor') {
            throw new Error('Cadastro canônico de Vitor não foi encontrado.');
        }
        if (String(player.jogo_status || '').toLowerCase() !== 'liberado') {
            throw new Error(`Vitor continua com jogo_status=${player.jogo_status || 'vazio'}.`);
        }
        if (!player.jogo_liberado_at || !player.jogo_liberado_by || player.jogo_bloqueio_motivo) {
            throw new Error('Metadados de acesso de Vitor ficaram inconsistentes.');
        }

        assertExpectedCounts({ totals, overall, vitor, pending, linked });

        const foreignKeys = await db.all('PRAGMA foreign_key_check');
        if (foreignKeys.length) {
            throw new Error(`foreign_key_check: ${foreignKeys.length} falha(s).`);
        }

        const integrity = await db.all('PRAGMA integrity_check');
        const failures = integrity
            .flatMap((row) => Object.values(row))
            .filter((value) => String(value).toLowerCase() !== 'ok');
        if (failures.length) {
            throw new Error(`integrity_check: ${failures.join('; ')}`);
        }

        console.log('Integridade SQLite: OK');
        console.log('Lote canônico 1: COMPLETO');
    } finally {
        await db.close();
    }
}

async function main() {
    process.chdir(REPO_ROOT);
    console.log('\n=== FINALIZAÇÃO CANÔNICA — LOTE 1 ===');

    assertRepositoryReady();

    console.log('\n=== VALIDANDO CÓDIGO ===');
    runChecked(process.execPath, ['--check', 'scripts/repairVitorAccessRegression.js'], 'Erro de sintaxe no reparador de Vitor.');
    runChecked(process.execPath, ['--check', 'scripts/importCanonicalPlayerContentBatch1.js'], 'Erro de sintaxe no importador canônico.');

    await waitForQueueIdle();

    let botStopped = false;
    let operationError = null;

    try {
        console.log('\n=== PARANDO SOMENTE O CLOVER — PM2 ID 1 ===');
        runChecked(PM2_COMMAND, ['stop', '1'], 'Não foi possível parar o PM2 ID 1.');
        botStopped = true;

        console.log('\n=== CORRIGINDO ACESSO DE VITOR ===');
        runChecked(
            process.execPath,
            [
                'scripts/repairVitorAccessRegression.js',
                `--db=${DATABASE_FILE}`,
                `--output=${OUTPUT_DIR}`,
                '--apply',
                `--confirm=${REPAIR_CONFIRMATION}`,
            ],
            'A reparação de Vitor falhou. O lote não será importado.'
        );

        console.log('\n=== COMPLETANDO OS 22 REGISTROS CANÔNICOS ===');
        runChecked(
            process.execPath,
            [
                'scripts/importCanonicalPlayerContentBatch1.js',
                `--db=${DATABASE_FILE}`,
                `--manifest=${MANIFEST_FILE}`,
                `--output=${OUTPUT_DIR}`,
                '--apply',
                `--confirm=${IMPORT_CONFIRMATION}`,
            ],
            'A importação canônica falhou.'
        );

        await verifyFinalState();
    } catch (error) {
        operationError = error;
    } finally {
        if (botStopped) {
            console.log('\n=== RELIGANDO SOMENTE O CLOVER — PM2 ID 1 ===');
            try {
                runChecked(PM2_COMMAND, ['restart', '1', '--update-env'], 'Falha ao religar o PM2 ID 1.');
            } catch (restartError) {
                if (operationError) {
                    console.error(restartError.stack || restartError);
                } else {
                    operationError = restartError;
                }
            }
        }
    }

    if (operationError) throw operationError;

    await waitForCloverOnline();
    runChecked(PM2_COMMAND, ['save'], 'O lote foi concluído, mas o pm2 save falhou.');

    console.log('\n=== LOTE 1 CONCLUÍDO: 10 JOGADORES, 22 REGISTROS ===');
}

if (require.main === module) {
    main().catch((error) => {
        console.error('\nFALHA NA FINALIZAÇÃO CANÔNICA:');
        console.error(error?.stack || error);
        process.exitCode = 1;
    });
}

module.exports = {
    assertExpectedCounts,
    isQueueIdle,
    resolveCommandInvocation,
    runChecked,
};