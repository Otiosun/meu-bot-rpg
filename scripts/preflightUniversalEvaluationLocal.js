'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getMigrationFeatureFlags } = require('../helpers/clover/migrationFeatureFlags');
const {
    backupSqliteDatabase,
    verifySqliteDatabase,
} = require('../helpers/clover/sqliteBackupService');

const EXPECTED_BRANCH = 'clover/evaluation-support-migration-2026-10-13';
const EXPECTED_PM2_NAME = 'clover-rpg';
const ROOT = path.resolve(__dirname, '..');

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd || ROOT,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        env: process.env,
    });
    return {
        ok: !result.error && result.status === 0,
        status: result.status,
        stdout: String(result.stdout || '').trim(),
        stderr: String(result.stderr || '').trim(),
        error: result.error?.message || null,
    };
}

function git(args) {
    return run('git', args);
}

function normalizePath(value) {
    const resolved = path.resolve(String(value || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function recursiveFileCount(directory) {
    if (!fs.existsSync(directory)) return 0;
    let total = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) total += recursiveFileCount(target);
        else if (entry.isFile()) total += 1;
    }
    return total;
}

function readPm2Processes() {
    const command = process.platform === 'win32' ? 'cmd.exe' : 'pm2';
    const args = process.platform === 'win32'
        ? ['/d', '/s', '/c', 'pm2 jlist']
        : ['jlist'];
    const result = run(command, args);
    if (!result.ok) {
        return { ok: false, error: result.error || result.stderr || 'pm2 indisponível', processes: [] };
    }
    try {
        const parsed = JSON.parse(result.stdout || '[]');
        return {
            ok: true,
            processes: parsed.map((item) => ({
                id: item.pm_id,
                name: item.name,
                status: item.pm2_env?.status || null,
                cwd: item.pm2_env?.pm_cwd || null,
                script: item.pm2_env?.pm_exec_path || null,
                restarts: item.pm2_env?.restart_time ?? null,
            })),
        };
    } catch (error) {
        return { ok: false, error: `pm2 jlist inválido: ${error.message}`, processes: [] };
    }
}

function timestampForPath(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, '-');
}

function resolveDatabasePath() {
    const configured = process.env.CLOVER_DATABASE_PATH || process.env.CLOVER_DB_PATH || '';
    return path.resolve(ROOT, configured || 'banco.sqlite');
}

function addCheck(checks, name, ok, details = null, blocking = true) {
    checks.push({ name, ok: Boolean(ok), blocking: Boolean(blocking), details });
}

function printReport(report) {
    console.log('');
    console.log('CLOVER — PREFLIGHT LOCAL · FILA UNIVERSAL');
    console.log('-----------------------------------------');
    for (const check of report.checks) {
        const state = check.ok ? 'PASS' : (check.blocking ? 'FAIL' : 'WARN');
        console.log(`[${state}] ${check.name}${check.details ? ` — ${check.details}` : ''}`);
    }
    if (report.backup) {
        console.log(`[PASS] backup SQLite — ${report.backup.destinationPath} (${report.backup.bytes} bytes, integrity=${report.backup.integrity})`);
    }
    console.log('-----------------------------------------');
    console.log(report.ready
        ? 'PREFLIGHT APROVADO. Nenhuma migration/restart foi executada.'
        : 'PREFLIGHT BLOQUEADO. Nada foi migrado/reiniciado.');
    console.log('');
}

async function runPreflight(options = {}) {
    const checks = [];
    const backupRequested = Boolean(options.backup);
    const dbPath = resolveDatabasePath();
    const authPath = path.join(ROOT, 'auth_info');

    const nodeMajor = Number(process.versions.node.split('.')[0]);
    addCheck(checks, 'Node >= 24', Number.isInteger(nodeMajor) && nodeMajor >= 24, process.version);

    const topLevel = git(['rev-parse', '--show-toplevel']);
    addCheck(
        checks,
        'repositório Git correto',
        topLevel.ok && normalizePath(topLevel.stdout) === normalizePath(ROOT),
        topLevel.ok ? topLevel.stdout : (topLevel.error || topLevel.stderr)
    );

    const branch = git(['branch', '--show-current']);
    addCheck(
        checks,
        `branch ${EXPECTED_BRANCH}`,
        branch.ok && branch.stdout === EXPECTED_BRANCH,
        branch.ok ? (branch.stdout || '(detached)') : (branch.error || branch.stderr)
    );

    const status = git(['status', '--porcelain']);
    addCheck(
        checks,
        'árvore Git limpa',
        status.ok && !status.stdout,
        status.ok ? (status.stdout ? status.stdout.split(/\r?\n/).slice(0, 8).join(' | ') : 'sem alterações') : (status.error || status.stderr)
    );

    const head = git(['rev-parse', 'HEAD']);
    addCheck(checks, 'HEAD legível', head.ok && /^[0-9a-f]{40}$/i.test(head.stdout), head.ok ? head.stdout : (head.error || head.stderr));

    const authExists = fs.existsSync(authPath) && fs.statSync(authPath).isDirectory();
    const authFiles = authExists ? recursiveFileCount(authPath) : 0;
    addCheck(checks, 'sessão auth_info presente', authExists && authFiles > 0, authExists ? `${authFiles} arquivos; somente leitura neste preflight` : 'diretório ausente');

    const dbExists = fs.existsSync(dbPath) && fs.statSync(dbPath).isFile();
    addCheck(checks, 'banco SQLite presente', dbExists, dbPath);
    if (dbExists) {
        try {
            const integrity = await verifySqliteDatabase(dbPath);
            addCheck(checks, 'PRAGMA integrity_check', integrity.ok, String(integrity.integrity || 'sem resultado'));
        } catch (error) {
            addCheck(checks, 'PRAGMA integrity_check', false, error?.message || String(error));
        }
    }

    const flags = getMigrationFeatureFlags(process.env);
    addCheck(
        checks,
        'fila universal ainda OFF antes do apply',
        flags.universalEvaluation === false,
        `CLOVER_UNIVERSAL_EVALUATION=${process.env.CLOVER_UNIVERSAL_EVALUATION || '0'}`
    );

    const pm2 = readPm2Processes();
    addCheck(checks, 'PM2 acessível', pm2.ok, pm2.ok ? `${pm2.processes.length} processo(s)` : pm2.error);
    if (pm2.ok) {
        const clover = pm2.processes.find((item) => item.name === EXPECTED_PM2_NAME) || null;
        addCheck(checks, `PM2 ${EXPECTED_PM2_NAME} existe`, Boolean(clover), clover ? `id=${clover.id}; status=${clover.status}` : 'não encontrado');
        if (clover) {
            addCheck(checks, `PM2 ${EXPECTED_PM2_NAME} online`, clover.status === 'online', clover.status || 'sem status');
            addCheck(
                checks,
                `PM2 ${EXPECTED_PM2_NAME} aponta para este repo`,
                Boolean(clover.cwd) && normalizePath(clover.cwd) === normalizePath(ROOT),
                clover.cwd || 'cwd ausente'
            );
        }
    }

    let backup = null;
    const blockingFailuresBeforeBackup = checks.filter((check) => check.blocking && !check.ok);
    if (backupRequested && blockingFailuresBeforeBackup.length === 0) {
        const destination = path.join(
            ROOT,
            'backups',
            `universal-evaluation-preflight-${timestampForPath()}`,
            path.basename(dbPath)
        );
        backup = await backupSqliteDatabase(dbPath, destination);
    }

    const ready = checks.every((check) => !check.blocking || check.ok) && (!backupRequested || Boolean(backup));
    return {
        ready,
        backupRequested,
        root: ROOT,
        dbPath,
        authPath,
        head: head.ok ? head.stdout : null,
        flags,
        checks,
        backup,
    };
}

async function runCli() {
    const args = new Set(process.argv.slice(2));
    const unknown = [...args].filter((arg) => arg !== '--backup' && arg !== '--json');
    if (unknown.length) {
        console.error(`Argumento desconhecido: ${unknown.join(', ')}`);
        process.exitCode = 2;
        return;
    }

    try {
        const report = await runPreflight({ backup: args.has('--backup') });
        if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
        else printReport(report);
        if (!report.ready) process.exitCode = 1;
    } catch (error) {
        console.error('[preflight] falha:', error?.stack || error?.message || error);
        process.exitCode = 1;
    }
}

if (require.main === module) void runCli();

module.exports = {
    EXPECTED_BRANCH,
    EXPECTED_PM2_NAME,
    ROOT,
    readPm2Processes,
    resolveDatabasePath,
    runPreflight,
    timestampForPath,
};
