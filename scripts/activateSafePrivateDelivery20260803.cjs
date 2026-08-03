'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'index.js');
const DB_PATH = path.join(ROOT, 'banco.sqlite');
const BACKUP_DIR = path.join(ROOT, 'backups');
const CONFIRMATION = 'ATIVAR-PV-TRANSACIONAL-2026-08-03';
const PM2_PROCESS = 'clover-rpg';

const SAFE_ENV = Object.freeze({
    CLOVER_PV_POLICY_MODE: 'enforce',
    CLOVER_PV_DELIVERY_WORKER_ENABLED: '1',
    CLOVER_PV_DELIVERY_RUN_ON_OPEN: '1',
    CLOVER_DELIVERY_QUEUE_ENABLED: '1',
    CLOVER_PV_DELIVERY_INTERVAL_MS: '15000',
    CLOVER_PV_DELIVERY_MAX_AGE_HOURS: '72',
    CLOVER_PV_PROACTIVE_ENABLED: '0',
    CLOVER_PV_BULK_ENABLED: '0',
    CLOVER_WEEKLY_CHECKLIST_AUTO_PV: '0',
    CLOVER_PRIVATE_REPLY_FANOUT: '0',
});

function parseArgs(argv) {
    const apply = argv.includes('--apply');
    const confirmationArg = argv.find((arg) => arg.startsWith('--confirm='));
    const confirmation = confirmationArg
        ? confirmationArg.slice('--confirm='.length)
        : null;
    if (apply && confirmation !== CONFIRMATION) {
        throw new Error(`Aplicação bloqueada. Use --apply --confirm=${CONFIRMATION}`);
    }
    return { apply };
}

function timestamp() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        '-',
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join('');
}

function run(command, args = [], options = {}) {
    const result = spawnSync(command, args, {
        cwd: ROOT,
        env: options.env || process.env,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        windowsHide: true,
    });
    return {
        status: result.status,
        stdout: String(result.stdout || '').trim(),
        stderr: String(result.stderr || '').trim(),
        error: result.error || null,
    };
}

function requireSuccess(result, label) {
    if (result.status === 0 && !result.error) return result;
    throw new Error([
        `${label} falhou.`,
        result.error?.message || '',
        result.stderr || '',
        result.stdout || '',
    ].filter(Boolean).join('\n'));
}

function readPm2Process() {
    const result = requireSuccess(run('pm2', ['jlist']), 'Leitura do PM2');
    let list;
    try {
        list = JSON.parse(result.stdout || '[]');
    } catch (error) {
        throw new Error(`PM2 retornou JSON inválido: ${error.message}`);
    }
    const processInfo = list.find((item) => item?.name === PM2_PROCESS);
    if (!processInfo) throw new Error(`Processo PM2 ${PM2_PROCESS} não encontrado.`);
    return processInfo;
}

function replaceOnce(text, search, replacement, label) {
    const index = text.indexOf(search);
    if (index < 0) throw new Error(`Não encontrei o trecho: ${label}.`);
    if (text.indexOf(search, index + search.length) >= 0) {
        throw new Error(`Trecho ambíguo encontrado mais de uma vez: ${label}.`);
    }
    return text.slice(0, index) + replacement + text.slice(index + search.length);
}

function buildPatchedIndex(originalText) {
    const hadBom = originalText.charCodeAt(0) === 0xFEFF;
    let text = hadBom ? originalText.slice(1) : originalText;
    const eol = text.includes('\r\n') ? '\r\n' : '\n';

    const requiredMarkers = [
        "const { runPrivateDeliveryWorkerOnce } = require('./helpers/clover/privateDeliveryRuntimeHook');",
        'async function iniciarBot()',
        'const privateDeliveryResult = await runPrivateDeliveryWorkerOnce({',
        'weeklyChecklistTimer: null,',
    ];
    for (const marker of requiredMarkers) {
        if (!text.includes(marker) && !text.includes('iniciarTimerEntregaPv(sock, db);')) {
            throw new Error(`Runtime incompatível: marcador ausente: ${marker}`);
        }
    }

    if (!text.includes('pvDeliveryTimer: null,')) {
        text = replaceOnce(
            text,
            `    weeklyChecklistTimer: null,${eol}`,
            `    weeklyChecklistTimer: null,${eol}    pvDeliveryTimer: null,${eol}    pvDeliveryRunning: false,${eol}`,
            'estado do runtime privado'
        );
    }

    if (!text.includes('function limparTimerEntregaPv()')) {
        const timerFunctionPattern = /function limparTimerChecklistSemanal\(\) \{[\s\S]*?\r?\n\}/;
        const match = text.match(timerFunctionPattern);
        if (!match) throw new Error('Não encontrei limparTimerChecklistSemanal.');
        const addition = [
            '',
            'function limparTimerEntregaPv() {',
            '    if (!runtimeClover.pvDeliveryTimer) return;',
            '    clearInterval(runtimeClover.pvDeliveryTimer);',
            '    runtimeClover.pvDeliveryTimer = null;',
            '}',
        ].join(eol);
        text = text.replace(timerFunctionPattern, `${match[0]}${eol}${addition}`);
    }

    const shutdownBefore = [
        '    limparTimerReconexao();',
        '    limparTimerChecklistSemanal();',
        '    limparTimerEconomia();',
    ].join(eol);
    const shutdownAfter = [
        '    limparTimerReconexao();',
        '    limparTimerChecklistSemanal();',
        '    limparTimerEntregaPv();',
        '    limparTimerEconomia();',
    ].join(eol);
    if (!text.includes(shutdownAfter)) {
        text = replaceOnce(text, shutdownBefore, shutdownAfter, 'limpeza no encerramento');
    }

    const closeBefore = [
        '            limparTimerChecklistSemanal();',
        '            limparTimerEconomia();',
    ].join(eol);
    const closeAfter = [
        '            limparTimerChecklistSemanal();',
        '            limparTimerEntregaPv();',
        '            limparTimerEconomia();',
    ].join(eol);
    if (!text.includes(closeAfter)) {
        text = replaceOnce(text, closeBefore, closeAfter, 'limpeza na desconexão');
    }

    if (!text.includes('async function executarEntregaPvSegura(')) {
        const helper = [
            'function resolverIntervaloEntregaPv() {',
            "    const configured = Number(process.env.CLOVER_PV_DELIVERY_INTERVAL_MS || 15000);",
            '    if (!Number.isFinite(configured)) return 15000;',
            '    return Math.max(10000, Math.min(300000, Math.floor(configured)));',
            '}',
            '',
            "async function executarEntregaPvSegura(sock, db, contexto = 'timer') {",
            '    if (runtimeClover.pvDeliveryRunning) {',
            "        return { ok: true, skipped: true, reason: 'cycle_already_running' };",
            '    }',
            '    runtimeClover.pvDeliveryRunning = true;',
            '    try {',
            '        const result = await runPrivateDeliveryWorkerOnce({',
            '            sock,',
            '            db,',
            '            env: process.env,',
            '            context: contexto,',
            '        });',
            '        if (',
            '            !result?.skipped',
            "            || !['worker_disabled', 'run_on_open_disabled', 'empty_queue'].includes(result?.reason)",
            '        ) {',
            "            console.log('[pv-delivery] ciclo seguro:', {",
            '                contexto,',
            '                ok: result?.ok ?? null,',
            '                skipped: result?.skipped ?? false,',
            '                reason: result?.reason || null,',
            '                jobId: result?.jobId || null,',
            '                status: result?.status || null,',
            '                sent: result?.sent === true,',
            '            });',
            '        }',
            '        return result;',
            '    } catch (error) {',
            "        console.log('[pv-delivery] falha no ciclo seguro:', error?.message || error);",
            "        return { ok: false, error: error?.message || String(error) };",
            '    } finally {',
            '        runtimeClover.pvDeliveryRunning = false;',
            '    }',
            '}',
            '',
            'function iniciarTimerEntregaPv(sock, db) {',
            '    limparTimerEntregaPv();',
            '    const workerEnabled = process.env.CLOVER_PV_DELIVERY_WORKER_ENABLED === \'1\';',
            '    const runEnabled = process.env.CLOVER_PV_DELIVERY_RUN_ON_OPEN === \'1\';',
            '    if (!workerEnabled || !runEnabled) {',
            "        console.log('[pv-delivery] timer transacional desativado por flags.');",
            '        return;',
            '    }',
            '    const intervalMs = resolverIntervaloEntregaPv();',
            '    runtimeClover.pvDeliveryTimer = setInterval(async () => {',
            '        if (runtimeClover.sockAtivo !== sock || runtimeClover.dbAtivo !== db) return;',
            "        await executarEntregaPvSegura(sock, db, 'timer');",
            '    }, intervalMs);',
            '    runtimeClover.pvDeliveryTimer.unref?.();',
            "    console.log(`[pv-delivery] timer transacional ativo: ${intervalMs}ms.`);",
            '}',
            '',
        ].join(eol);
        text = replaceOnce(
            text,
            'async function iniciarBot()',
            `${helper}async function iniciarBot()`,
            'entrada do iniciarBot'
        );
    }

    if (!text.includes('iniciarTimerEntregaPv(sock, db);')) {
        const workerBlockPattern = /            try \{\r?\n                const privateDeliveryResult = await runPrivateDeliveryWorkerOnce\(\{[\s\S]*?\r?\n            \} catch \(error\) \{\r?\n                console\.log\('\[pv-delivery\] falha na execucao controlada:', error\?\.message \|\| error\);\r?\n            \}/;
        const match = text.match(workerBlockPattern);
        if (!match) throw new Error('Não encontrei o hook privado de abertura para substituir.');
        const replacement = [
            "            await executarEntregaPvSegura(sock, db, 'abertura');",
            '            iniciarTimerEntregaPv(sock, db);',
        ].join(eol);
        text = text.replace(workerBlockPattern, replacement);
    }

    const requiredFinalMarkers = [
        'pvDeliveryTimer: null,',
        'function limparTimerEntregaPv()',
        'async function executarEntregaPvSegura(',
        'function iniciarTimerEntregaPv(',
        "await executarEntregaPvSegura(sock, db, 'abertura');",
        'iniciarTimerEntregaPv(sock, db);',
    ];
    for (const marker of requiredFinalMarkers) {
        if (!text.includes(marker)) throw new Error(`Patch incompleto: ${marker}`);
    }

    return (hadBom ? '\uFEFF' : '') + text;
}

async function auditQueue(env) {
    if (!fs.existsSync(DB_PATH)) throw new Error(`Banco não encontrado: ${DB_PATH}`);
    const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    try {
        await db.exec('PRAGMA query_only = ON');
        const table = await db.get(
            "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='clover_delivery_jobs'"
        );
        if (!table) {
            return { total: 0, eligible: [], blocked: [], expired: [], processing: [] };
        }
        const jobs = await db.all(
            `SELECT * FROM clover_delivery_jobs
             WHERE status = 'pending'
               AND kind IN ('private_text', 'private_message', 'spell_review_invite')
             ORDER BY priority DESC, id ASC`
        );
        const processing = await db.all(
            `SELECT id, kind, target_jid, created_by, attempts, locked_at, locked_by
             FROM clover_delivery_jobs
             WHERE status = 'processing'
               AND kind IN ('private_text', 'private_message', 'spell_review_invite')
             ORDER BY id ASC`
        );
        const {
            buildQueuePolicyInput,
            evaluateQueuedPrivateJob,
            isQueuedJobExpired,
        } = require('../helpers/clover/privateDeliveryWorker');
        const result = { total: jobs.length, eligible: [], blocked: [], expired: [], processing };
        for (const job of jobs) {
            const input = buildQueuePolicyInput(job);
            const summary = {
                id: job.id,
                kind: job.kind,
                target: job.target_jid,
                source: input.source,
                priority: Number(job.priority || 0),
                attempts: Number(job.attempts || 0),
                createdAt: job.created_at,
            };
            if (isQueuedJobExpired(job, env)) {
                result.expired.push(summary);
                continue;
            }
            const decision = evaluateQueuedPrivateJob(job, env);
            if (decision.allowed) result.eligible.push(summary);
            else result.blocked.push({ ...summary, reason: decision.reason });
        }
        return result;
    } finally {
        await db.close();
    }
}

function printQueueAudit(audit) {
    console.log('============================================================');
    console.log('AUDITORIA DA FILA PRIVADA');
    console.log('============================================================');
    console.log(`Pendentes privados: ${audit.total}`);
    console.log(`Elegíveis transacionais/reativos: ${audit.eligible.length}`);
    console.log(`Bloqueados pela política: ${audit.blocked.length}`);
    console.log(`Vencidos (>72h): ${audit.expired.length}`);
    console.log(`Em processamento agora: ${audit.processing.length}`);
    for (const item of audit.eligible.slice(0, 20)) {
        console.log(`  [ELEGÍVEL] #${item.id} ${item.kind} | ${item.source || '-'} | ${item.target}`);
    }
    for (const item of audit.blocked.slice(0, 20)) {
        console.log(`  [BLOQUEADO] #${item.id} ${item.kind} | ${item.source || '-'} | ${item.reason}`);
    }
    for (const item of audit.expired.slice(0, 20)) {
        console.log(`  [VENCIDO] #${item.id} ${item.kind} | ${item.source || '-'} | ${item.createdAt}`);
    }
}

function persistUserEnvironment(envValues) {
    if (process.platform !== 'win32') return;
    for (const [key, value] of Object.entries(envValues)) {
        requireSuccess(run('setx', [key, value]), `Persistência de ${key}`);
    }
}

function verifyPm2Environment() {
    const processInfo = readPm2Process();
    const env = processInfo?.pm2_env || {};
    const mismatches = [];
    for (const [key, expected] of Object.entries(SAFE_ENV)) {
        const actual = String(env[key] ?? '');
        if (actual !== expected) mismatches.push(`${key}: esperado=${expected}; atual=${actual || '<vazio>'}`);
    }
    if (mismatches.length) {
        throw new Error(`PM2 não recebeu as flags seguras:\n${mismatches.join('\n')}`);
    }
    return processInfo;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(INDEX_PATH)) throw new Error(`index.js não encontrado: ${INDEX_PATH}`);

    const pm2Before = readPm2Process();
    const currentPm2Env = pm2Before?.pm2_env || {};
    const safeBoot = String(currentPm2Env.CLOVER_SAFE_BOOT || process.env.CLOVER_SAFE_BOOT || '0');
    if (safeBoot === '1') {
        throw new Error('CLOVER_SAFE_BOOT=1 está ativo. Não vou desativar uma trava emergencial automaticamente.');
    }

    const proposedEnv = { ...process.env, ...SAFE_ENV };
    const audit = await auditQueue(proposedEnv);
    printQueueAudit(audit);

    const original = fs.readFileSync(INDEX_PATH, 'utf8');
    const patched = buildPatchedIndex(original);
    const alreadyPatched = patched === original;

    console.log('============================================================');
    console.log(`Runtime com timer seguro: ${alreadyPatched ? 'já instalado' : 'será instalado'}`);
    console.log('Política: enforce');
    console.log('Worker: ativo');
    console.log('Intervalo: 15 segundos, um job por ciclo');
    console.log('Proativos/checklist/lotes: bloqueados');
    console.log('============================================================');

    if (!args.apply) {
        console.log('PREVIEW CONCLUÍDO. Nenhuma alteração foi realizada.');
        return;
    }

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    let backupPath = null;
    if (!alreadyPatched) {
        backupPath = path.join(BACKUP_DIR, `index.before-safe-pv-${timestamp()}.js`);
        fs.copyFileSync(INDEX_PATH, backupPath);
        fs.writeFileSync(INDEX_PATH, patched, 'utf8');
        const syntax = run(process.execPath, ['--check', INDEX_PATH]);
        if (syntax.status !== 0 || syntax.error) {
            fs.copyFileSync(backupPath, INDEX_PATH);
            throw new Error(`Patch revertido por erro de sintaxe:\n${syntax.stderr || syntax.stdout}`);
        }
    }

    try {
        persistUserEnvironment(SAFE_ENV);
        const restartEnv = { ...process.env, ...SAFE_ENV };
        requireSuccess(
            run('pm2', ['restart', PM2_PROCESS, '--update-env'], { env: restartEnv }),
            'Reinício do clover-rpg'
        );
        requireSuccess(run('pm2', ['save'], { env: restartEnv }), 'pm2 save');
        verifyPm2Environment();
    } catch (error) {
        if (backupPath) {
            fs.copyFileSync(backupPath, INDEX_PATH);
            run('pm2', ['restart', PM2_PROCESS, '--update-env'], { env: process.env });
        }
        throw error;
    }

    const postAudit = await auditQueue(proposedEnv);
    console.log('============================================================');
    console.log('ATIVAÇÃO CONCLUÍDA');
    console.log(`Backup do index: ${backupPath || 'não necessário; runtime já estava instalado'}`);
    console.log('PM2: clover-rpg reiniciado e salvo');
    console.log('PV transacional: ativo');
    console.log('Checklist/anti-ghost automático/lotes: permanecem bloqueados pela política');
    console.log(`Fila elegível no instante da ativação: ${postAudit.eligible.length}`);
    console.log('============================================================');
}

main().catch((error) => {
    console.error(`FALHA: ${error?.stack || error}`);
    process.exitCode = 1;
});
