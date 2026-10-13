'use strict';

const { spawnSync } = require('child_process');

const { CANONICAL_SCHEMA_MIGRATIONS } = require('../database');
const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const { runCloverSchemaMigrations } = require('../helpers/clover/schemaMigrationService');
const { verifySqliteDatabase } = require('../helpers/clover/sqliteBackupService');
const {
    EXPECTED_PM2_NAME,
    ROOT,
    readPm2Processes,
    resolveDatabasePath,
    runPreflight,
} = require('./preflightUniversalEvaluationLocal');

const CONFIRM_TOKEN = 'APPLY_UNIVERSAL_EVALUATION_LOCAL';
const EXPECTED_MIGRATIONS = Object.freeze([31, 32, 33, 34]);
const ALLOWED_START_VERSIONS = Object.freeze([30, 31, 32, 33, 34]);

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

function pm2Command(args, env = process.env) {
    if (process.platform === 'win32') {
        return run('cmd.exe', ['/d', '/s', '/c', ['pm2', ...args].join(' ')], env);
    }
    return run('pm2', args, env);
}

async function inspectMigrationStartingPoint(dbPath) {
    const db = await openCloverDatabase({ filename: dbPath });
    try {
        const ledger = await db.get(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'clover_schema_migrations'"
        );
        if (!ledger) {
            const error = new Error('clover_schema_migrations não existe; banco não está no baseline esperado.');
            error.code = 'local_apply_missing_migration_ledger';
            throw error;
        }
        const latestRow = await db.get('SELECT MAX(version) AS latest FROM clover_schema_migrations');
        const userVersionRow = await db.get('PRAGMA user_version');
        const latest = Number(latestRow?.latest || 0);
        const userVersion = Number(Object.values(userVersionRow || {})[0] || 0);
        if (!ALLOWED_START_VERSIONS.includes(latest)) {
            const error = new Error(`Versão inicial inesperada: ${latest}. Esperado 30–34.`);
            error.code = 'local_apply_unexpected_start_version';
            error.latest = latest;
            throw error;
        }
        if (userVersion !== latest) {
            const error = new Error(`PRAGMA user_version=${userVersion} diverge do ledger=${latest}.`);
            error.code = 'local_apply_user_version_mismatch';
            error.latest = latest;
            error.userVersion = userVersion;
            throw error;
        }
        return { latest, userVersion };
    } finally {
        await db.close().catch(() => {});
    }
}

async function applyMigrations(dbPath) {
    const db = await openCloverDatabase({ filename: dbPath });
    try {
        await runCloverSchemaMigrations(db, { migrations: CANONICAL_SCHEMA_MIGRATIONS });
        const rows = await db.all(
            `SELECT version, migration_key, applied_at
             FROM clover_schema_migrations
             WHERE version BETWEEN 31 AND 34
             ORDER BY version ASC`
        );
        const versions = rows.map((row) => Number(row.version));
        const missing = EXPECTED_MIGRATIONS.filter((version) => !versions.includes(version));
        if (missing.length) {
            const error = new Error(`Migrations ausentes após apply: ${missing.join(', ')}`);
            error.code = 'local_apply_migration_verification_failed';
            throw error;
        }
        const userVersionRow = await db.get('PRAGMA user_version');
        const userVersion = Number(Object.values(userVersionRow || {})[0] || 0);
        if (userVersion !== 34) {
            const error = new Error(`PRAGMA user_version deveria ser 34 após apply; observado ${userVersion}.`);
            error.code = 'local_apply_final_user_version_mismatch';
            throw error;
        }
        return rows;
    } finally {
        await db.close().catch(() => {});
    }
}

async function waitForPm2Online(timeoutMs = 45_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const pm2 = readPm2Processes();
        if (pm2.ok) {
            const clover = pm2.processes.find((item) => item.name === EXPECTED_PM2_NAME);
            if (clover?.status === 'online') return clover;
        }
        await new Promise((resolve) => setTimeout(resolve, 750));
    }
    return null;
}

function restartWithFeatureOff() {
    const env = {
        ...process.env,
        CLOVER_UNIVERSAL_EVALUATION: '0',
        // Há colisões legadas conhecidas; strict ownership permanece desligado neste checkpoint.
        CLOVER_STRICT_COMMAND_OWNERSHIP: '0',
    };
    return pm2Command(['restart', EXPECTED_PM2_NAME, '--update-env'], env);
}

function runRuntimeDiagnosis() {
    return run(process.execPath, ['scripts/diagnoseCloverRuntime.js']);
}

async function applyLocalCheckpoint() {
    const preflight = await runPreflight({ backup: true });
    if (!preflight.ready) {
        const error = new Error('Preflight local falhou. Nenhuma migration/restart foi executada.');
        error.code = 'local_apply_preflight_failed';
        error.report = preflight;
        throw error;
    }

    const dbPath = resolveDatabasePath();
    const startingPoint = await inspectMigrationStartingPoint(dbPath);
    let migrations;
    try {
        // As migrations 31–34 são aditivas. Rodamos enquanto o runtime antigo continua online;
        // se qualquer migration falhar, não reiniciamos o PM2 e o bot atual permanece de pé.
        migrations = await applyMigrations(dbPath);
    } catch (error) {
        error.preflightBackup = preflight.backup?.destinationPath || null;
        error.runtimeRestarted = false;
        throw error;
    }

    const integrity = await verifySqliteDatabase(dbPath);
    if (!integrity.ok) {
        const error = new Error(`Banco falhou no integrity_check após migrations: ${integrity.integrity || 'desconhecido'}`);
        error.code = 'local_apply_post_migration_integrity_failed';
        error.preflightBackup = preflight.backup?.destinationPath || null;
        error.runtimeRestarted = false;
        throw error;
    }

    const restart = restartWithFeatureOff();
    if (!restart.ok) {
        const error = new Error(`PM2 não reiniciou ${EXPECTED_PM2_NAME}: ${restart.error || restart.stderr || restart.stdout}`);
        error.code = 'local_apply_pm2_restart_failed';
        error.preflightBackup = preflight.backup?.destinationPath || null;
        error.runtimeRestarted = true;
        throw error;
    }

    const online = await waitForPm2Online();
    if (!online) {
        const error = new Error(`${EXPECTED_PM2_NAME} não voltou online dentro do prazo.`);
        error.code = 'local_apply_pm2_not_online';
        error.preflightBackup = preflight.backup?.destinationPath || null;
        error.runtimeRestarted = true;
        throw error;
    }

    const diagnosis = runRuntimeDiagnosis();
    if (!diagnosis.ok) {
        const error = new Error(`Diagnóstico pós-restart falhou: ${diagnosis.stderr || diagnosis.stdout || diagnosis.error}`);
        error.code = 'local_apply_runtime_diagnosis_failed';
        error.preflightBackup = preflight.backup?.destinationPath || null;
        error.runtimeRestarted = true;
        throw error;
    }

    return {
        ok: true,
        backup: preflight.backup,
        startingPoint,
        migrations,
        integrity: integrity.integrity,
        pm2: online,
        featureEnabled: false,
        diagnosis: diagnosis.stdout,
    };
}

function parseConfirm(argv) {
    const arg = argv.find((value) => value.startsWith('--confirm='));
    return arg ? arg.slice('--confirm='.length) : null;
}

async function runCli() {
    const confirm = parseConfirm(process.argv.slice(2));
    if (confirm !== CONFIRM_TOKEN) {
        console.error(`Confirmação obrigatória: --confirm=${CONFIRM_TOKEN}`);
        process.exitCode = 2;
        return;
    }

    try {
        const result = await applyLocalCheckpoint();
        console.log('');
        console.log('CLOVER — CHECKPOINT LOCAL APLICADO');
        console.log('--------------------------------');
        console.log(`Backup: ${result.backup?.destinationPath || '-'}`);
        console.log(`Schema antes: v${result.startingPoint.latest}`);
        console.log(`Migrations: ${result.migrations.map((row) => row.version).join(', ')}`);
        console.log(`SQLite: ${result.integrity}`);
        console.log(`PM2: ${result.pm2.status}`);
        console.log('Fila universal: OFF');
        console.log('auth_info: intocado');
        console.log('--------------------------------');
        console.log('Schema novo está instalado, mas o comportamento novo ainda NÃO foi ativado.');
        console.log('');
    } catch (error) {
        console.error('[apply-local] BLOQUEADO:', error?.message || error);
        if (error?.preflightBackup) console.error(`[apply-local] Backup: ${error.preflightBackup}`);
        if (error?.runtimeRestarted === false) {
            console.error('[apply-local] O PM2 não foi reiniciado; o runtime anterior continua rodando.');
        }
        process.exitCode = 1;
    }
}

if (require.main === module) void runCli();

module.exports = {
    ALLOWED_START_VERSIONS,
    CONFIRM_TOKEN,
    EXPECTED_MIGRATIONS,
    applyLocalCheckpoint,
    applyMigrations,
    inspectMigrationStartingPoint,
    parseConfirm,
    pm2Command,
    restartWithFeatureOff,
    runRuntimeDiagnosis,
    waitForPm2Online,
};
