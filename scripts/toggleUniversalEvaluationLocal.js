'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const { verifySqliteDatabase } = require('../helpers/clover/sqliteBackupService');
const {
    EXPECTED_BRANCH,
    EXPECTED_PM2_NAME,
    ROOT,
    readPm2Processes,
    resolveDatabasePath,
} = require('./preflightUniversalEvaluationLocal');

const ENABLE_TOKEN = 'ENABLE_UNIVERSAL_EVALUATION_LOCAL';
const DISABLE_TOKEN = 'DISABLE_UNIVERSAL_EVALUATION_LOCAL';
const REQUIRED_MIGRATIONS = Object.freeze([55, 56, 57, 58]);
const REQUIRED_USER_VERSION = 58;

function run(command, args, env = process.env) {
    const result = spawnSync(command, args, {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        env,
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

function pm2Command(args, env = process.env) {
    if (process.platform === 'win32') {
        return run('cmd.exe', ['/d', '/s', '/c', ['pm2', ...args].join(' ')], env);
    }
    return run('pm2', args, env);
}

async function assertRequiredMigrations(dbPath) {
    const integrity = await verifySqliteDatabase(dbPath);
    if (!integrity.ok) {
        const error = new Error(`SQLite integrity_check falhou: ${integrity.integrity || 'desconhecido'}`);
        error.code = 'local_toggle_integrity_failed';
        throw error;
    }

    const db = await openCloverDatabase({ filename: dbPath });
    try {
        const rows = await db.all(
            `SELECT version, migration_key
             FROM clover_schema_migrations
             WHERE version BETWEEN 55 AND 58
             ORDER BY version ASC`
        );
        const versions = rows.map((row) => Number(row.version));
        const missing = REQUIRED_MIGRATIONS.filter((version) => !versions.includes(version));
        if (missing.length) {
            const error = new Error(`Migrations obrigatórias ausentes: ${missing.join(', ')}`);
            error.code = 'local_toggle_missing_migrations';
            throw error;
        }
        const userVersionRow = await db.get('PRAGMA user_version');
        const userVersion = Number(Object.values(userVersionRow || {})[0] || 0);
        if (userVersion !== REQUIRED_USER_VERSION) {
            const error = new Error(
                `PRAGMA user_version precisa ser ${REQUIRED_USER_VERSION} antes do enable; observado ${userVersion}.`
            );
            error.code = 'local_toggle_user_version_mismatch';
            throw error;
        }
        return { rows, integrity: integrity.integrity, userVersion };
    } finally {
        await db.close().catch(() => {});
    }
}

function assertLocalRuntimeShape() {
    const branch = git(['branch', '--show-current']);
    if (!branch.ok || branch.stdout !== EXPECTED_BRANCH) {
        throw new Error(`Branch incorreta. Esperado ${EXPECTED_BRANCH}; atual=${branch.stdout || branch.error || branch.stderr}`);
    }

    const status = git(['status', '--porcelain']);
    if (!status.ok || status.stdout) {
        throw new Error(`Árvore Git precisa estar limpa antes do toggle.${status.stdout ? ` Alterações: ${status.stdout}` : ''}`);
    }

    const pm2 = readPm2Processes();
    if (!pm2.ok) throw new Error(`PM2 indisponível: ${pm2.error || 'desconhecido'}`);
    const clover = pm2.processes.find((item) => item.name === EXPECTED_PM2_NAME);
    if (!clover) throw new Error(`Processo PM2 ${EXPECTED_PM2_NAME} não encontrado.`);
    if (clover.status !== 'online') throw new Error(`Processo PM2 ${EXPECTED_PM2_NAME} não está online (${clover.status || '-'}).`);
    if (!clover.cwd || normalizePath(clover.cwd) !== normalizePath(ROOT)) {
        throw new Error(`PM2 ${EXPECTED_PM2_NAME} aponta para outro cwd: ${clover.cwd || '<ausente>'}`);
    }
    return clover;
}

async function waitForDesiredState(enabled, timeoutMs = 45_000) {
    const desired = enabled ? '1' : '0';
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const pm2 = readPm2Processes();
        if (pm2.ok) {
            const clover = pm2.processes.find((item) => item.name === EXPECTED_PM2_NAME);
            const current = String(clover?.migrationFlags?.universalEvaluation ?? '0').trim();
            if (clover?.status === 'online' && current === desired) return clover;
        }
        await new Promise((resolve) => setTimeout(resolve, 750));
    }
    return null;
}

function restartWithState(enabled) {
    const env = {
        ...process.env,
        CLOVER_UNIVERSAL_EVALUATION: enabled ? '1' : '0',
        // O modo global estrito só entra depois da limpeza das colisões legadas.
        CLOVER_STRICT_COMMAND_OWNERSHIP: '0',
    };
    return pm2Command(['restart', EXPECTED_PM2_NAME, '--update-env'], env);
}

function runRuntimeDiagnosis() {
    return run(process.execPath, ['scripts/diagnoseCloverRuntime.js']);
}

async function toggleLocal(enabled) {
    assertLocalRuntimeShape();
    let database = null;
    if (enabled) database = await assertRequiredMigrations(resolveDatabasePath());

    const restart = restartWithState(enabled);
    if (!restart.ok) {
        throw new Error(`Falha ao reiniciar ${EXPECTED_PM2_NAME}: ${restart.error || restart.stderr || restart.stdout}`);
    }

    let observed = await waitForDesiredState(enabled);
    if (!observed && enabled) {
        restartWithState(false);
        observed = await waitForDesiredState(false);
        const error = new Error('Não consegui comprovar a fila universal ON; rollback automático para OFF foi solicitado.');
        error.code = 'local_toggle_enable_verification_failed';
        error.rollbackObserved = Boolean(observed);
        throw error;
    }
    if (!observed) {
        throw new Error('Não consegui comprovar o estado OFF após o restart.');
    }

    const diagnosis = runRuntimeDiagnosis();
    if (!diagnosis.ok) {
        if (enabled) {
            restartWithState(false);
            await waitForDesiredState(false);
        }
        const error = new Error(`Diagnóstico pós-toggle falhou: ${diagnosis.stderr || diagnosis.stdout || diagnosis.error}`);
        error.code = 'local_toggle_runtime_diagnosis_failed';
        throw error;
    }

    return {
        ok: true,
        enabled,
        pm2: observed,
        database,
        diagnosis: diagnosis.stdout,
        persistedWithPm2Save: false,
    };
}

function parseMode(argv) {
    const enable = argv.includes('--enable');
    const disable = argv.includes('--disable');
    if (enable === disable) return null;
    return enable ? 'enable' : 'disable';
}

function parseConfirm(argv) {
    const arg = argv.find((value) => value.startsWith('--confirm='));
    return arg ? arg.slice('--confirm='.length) : null;
}

async function runCli() {
    const argv = process.argv.slice(2);
    const mode = parseMode(argv);
    if (!mode) {
        console.error('Use exatamente um modo: --enable ou --disable');
        process.exitCode = 2;
        return;
    }
    const expected = mode === 'enable' ? ENABLE_TOKEN : DISABLE_TOKEN;
    if (parseConfirm(argv) !== expected) {
        console.error(`Confirmação obrigatória: --confirm=${expected}`);
        process.exitCode = 2;
        return;
    }

    try {
        const result = await toggleLocal(mode === 'enable');
        console.log('');
        console.log(`CLOVER — FILA UNIVERSAL ${result.enabled ? 'ON' : 'OFF'}`);
        console.log('--------------------------------');
        console.log(`PM2: ${result.pm2.status}`);
        console.log(`CLOVER_UNIVERSAL_EVALUATION=${result.enabled ? '1' : '0'}`);
        if (result.enabled && result.database) {
            console.log(`SQLite: ${result.database.integrity}; user_version=${result.database.userVersion}`);
        }
        console.log('pm2 save: NÃO executado (checkpoint reversível)');
        console.log('auth_info: intocado');
        console.log('--------------------------------');
        console.log('');
    } catch (error) {
        console.error('[toggle-local] BLOQUEADO:', error?.message || error);
        if (error?.rollbackObserved !== undefined) {
            console.error(`[toggle-local] rollback OFF observado: ${error.rollbackObserved ? 'sim' : 'não'}`);
        }
        process.exitCode = 1;
    }
}

if (require.main === module) void runCli();

module.exports = {
    DISABLE_TOKEN,
    ENABLE_TOKEN,
    REQUIRED_MIGRATIONS,
    REQUIRED_USER_VERSION,
    assertRequiredMigrations,
    parseConfirm,
    parseMode,
    restartWithState,
    toggleLocal,
    waitForDesiredState,
};