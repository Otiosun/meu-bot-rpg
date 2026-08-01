'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
    BlankPlayerIdentityCleanupError,
    applyCleanupPlan,
    buildCleanupPlan,
    validateAuditEvidence,
} = require('../helpers/clover/blankPlayerIdentityCleanupService');

function parseArgs(argv) {
    const options = {
        db: './banco.sqlite',
        auditReport: null,
        output: null,
        backup: null,
        expectedRunnerSha: process.env.CLOVER_RUNNER_SHA || null,
        expectedDatabaseSha256: null,
        apply: false,
        actor: null,
        reason: null,
        jsonOnly: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--db') options.db = argv[++index];
        else if (arg.startsWith('--db=')) options.db = arg.slice(5);
        else if (arg === '--audit-report') options.auditReport = argv[++index];
        else if (arg.startsWith('--audit-report=')) options.auditReport = arg.slice(15);
        else if (arg === '--output') options.output = argv[++index];
        else if (arg.startsWith('--output=')) options.output = arg.slice(9);
        else if (arg === '--backup') options.backup = argv[++index];
        else if (arg.startsWith('--backup=')) options.backup = arg.slice(9);
        else if (arg === '--expected-runner-sha') options.expectedRunnerSha = argv[++index];
        else if (arg.startsWith('--expected-runner-sha=')) options.expectedRunnerSha = arg.slice(22);
        else if (arg === '--expected-db-sha256') options.expectedDatabaseSha256 = argv[++index];
        else if (arg.startsWith('--expected-db-sha256=')) options.expectedDatabaseSha256 = arg.slice(21);
        else if (arg === '--actor') options.actor = argv[++index];
        else if (arg.startsWith('--actor=')) options.actor = arg.slice(8);
        else if (arg === '--reason') options.reason = argv[++index];
        else if (arg.startsWith('--reason=')) options.reason = arg.slice(9);
        else if (arg === '--apply') options.apply = true;
        else if (arg === '--json-only') options.jsonOnly = true;
        else throw new BlankPlayerIdentityCleanupError(`Argumento desconhecido: ${arg}`, 'unknown_argument');
    }
    return options;
}

function currentGitSha(cwd = path.resolve(__dirname, '..')) {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || null;
    } catch {
        return null;
    }
}

function sameSha(left, right) {
    if (!left || !right) return null;
    const a = String(left).trim();
    const b = String(right).trim();
    return a.startsWith(b) || b.startsWith(a);
}

function fileSha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function openDatabase(filename, readOnly) {
    const sqlite3 = require('sqlite3').verbose();
    const { open } = require('sqlite');
    const db = await open({
        filename,
        driver: sqlite3.Database,
        mode: readOnly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE,
    });
    await db.exec('PRAGMA busy_timeout = 10000');
    if (readOnly) {
        await db.exec('PRAGMA query_only = ON');
        const row = await db.get('PRAGMA query_only');
        if (Number(row?.query_only ?? Object.values(row || {})[0]) !== 1) {
            await db.close().catch(() => null);
            throw new BlankPlayerIdentityCleanupError(
                'Não foi possível confirmar PRAGMA query_only=ON.',
                'query_only_not_enabled'
            );
        }
    }
    return db;
}

function readAuditReport(filename) {
    if (!filename) {
        throw new BlankPlayerIdentityCleanupError(
            'Informe --audit-report.',
            'audit_report_required'
        );
    }
    const absolute = path.resolve(filename);
    if (!fs.existsSync(absolute)) {
        throw new BlankPlayerIdentityCleanupError(
            `Relatório não encontrado: ${absolute}`,
            'audit_report_not_found'
        );
    }
    try {
        return { path: absolute, report: JSON.parse(fs.readFileSync(absolute, 'utf8')) };
    } catch (error) {
        throw new BlankPlayerIdentityCleanupError(
            'Relatório de auditoria inválido.',
            'invalid_audit_report',
            { message: error.message }
        );
    }
}

async function createBackup(source, destination, expectedSha256) {
    if (!destination) {
        throw new BlankPlayerIdentityCleanupError('Informe --backup no modo apply.', 'backup_required');
    }
    const absolute = path.resolve(destination);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.copyFileSync(source, absolute, fs.constants.COPYFILE_EXCL);
    const backupSha256 = await fileSha256(absolute);
    if (backupSha256 !== expectedSha256) {
        throw new BlankPlayerIdentityCleanupError(
            'O backup não corresponde ao banco de origem.',
            'backup_hash_mismatch',
            { expectedSha256, backupSha256 }
        );
    }
    return { path: absolute, sha256: backupSha256 };
}

async function runCleanup(options, dependencies = {}) {
    const resolveGitSha = dependencies.currentGitSha || currentGitSha;
    const digestFile = dependencies.fileSha256 || fileSha256;
    const open = dependencies.openDatabase || openDatabase;
    const backupCreator = dependencies.createBackup || createBackup;
    const runnerSha = resolveGitSha();
    const expectedRunnerMatch = sameSha(runnerSha, options.expectedRunnerSha);
    if (options.expectedRunnerSha && expectedRunnerMatch !== true) {
        throw new BlankPlayerIdentityCleanupError(
            'O SHA do executor não corresponde ao esperado.',
            'runner_sha_mismatch',
            { runnerSha, expectedRunnerSha: options.expectedRunnerSha }
        );
    }

    const absoluteDb = path.resolve(options.db);
    if (!fs.existsSync(absoluteDb)) {
        throw new BlankPlayerIdentityCleanupError(`Banco não encontrado: ${absoluteDb}`, 'database_not_found');
    }
    const audit = readAuditReport(options.auditReport);
    const statBefore = fs.statSync(absoluteDb);
    const hashBefore = await digestFile(absoluteDb);
    if (options.expectedDatabaseSha256 && options.expectedDatabaseSha256 !== hashBefore) {
        throw new BlankPlayerIdentityCleanupError(
            'O SHA-256 do banco não corresponde ao esperado.',
            'database_sha256_mismatch',
            { expected: options.expectedDatabaseSha256, actual: hashBefore }
        );
    }
    const evidence = validateAuditEvidence(audit.report, hashBefore);
    let backup = null;
    if (options.apply) backup = await backupCreator(absoluteDb, options.backup, hashBefore);

    const db = await open(absoluteDb, !options.apply);
    let plan;
    let applied = null;
    try {
        plan = await buildCleanupPlan(db, evidence);
        if (options.apply) {
            applied = await applyCleanupPlan(db, plan, {
                actor: options.actor,
                reason: options.reason,
            });
        }
    } finally {
        await db.close().catch(() => null);
    }

    const statAfter = fs.statSync(absoluteDb);
    const hashAfter = await digestFile(absoluteDb);
    if (!options.apply && (
        hashBefore !== hashAfter
        || statBefore.size !== statAfter.size
        || statBefore.mtimeMs !== statAfter.mtimeMs
    )) {
        throw new BlankPlayerIdentityCleanupError(
            'O banco mudou durante o dry-run.',
            'database_changed_during_dry_run'
        );
    }

    const report = {
        version: 'clover.blank-player-identity-cleanup.v1',
        generatedAt: new Date().toISOString(),
        write: Boolean(options.apply),
        mode: options.apply ? 'apply' : 'dry-run',
        runner: {
            sha: runnerSha,
            expectedSha: options.expectedRunnerSha || null,
            expectedMatch: expectedRunnerMatch,
        },
        database: {
            path: absoluteDb,
            sha256Before: hashBefore,
            sha256After: hashAfter,
            sizeBefore: statBefore.size,
            sizeAfter: statAfter.size,
            unchanged: !options.apply,
        },
        auditEvidence: {
            path: audit.path,
            databaseSha256: evidence.sourceDatabaseSha256,
            rowCount: evidence.expectedCount,
            reviewReasons: evidence.allowedReviewReasons,
        },
        backup,
        plan: {
            safe: plan.safe,
            rowCount: plan.rowCount,
            rowids: plan.rowids,
        },
        applied,
    };

    if (options.output) {
        const output = path.resolve(options.output);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
        });
        report.outputPath = output;
    }
    return report;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const report = await runCleanup(options);
    if (options.jsonOnly) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
        console.log('[blank-cleanup] modo:', report.mode);
        console.log('[blank-cleanup] candidatos:', report.plan.rowCount);
        console.log('[blank-cleanup] banco antes:', report.database.sha256Before);
        console.log('[blank-cleanup] banco depois:', report.database.sha256After);
        if (report.backup) console.log('[blank-cleanup] backup:', report.backup.path);
        if (report.applied) console.log('[blank-cleanup] removidos:', report.applied.deletedCount);
        if (report.outputPath) console.log('[blank-cleanup] relatório:', report.outputPath);
    }
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${JSON.stringify({
            ok: false,
            error: error.code || 'blank_player_identity_cleanup_failed',
            message: error.message,
            details: error.details || null,
        }, null, 2)}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    createBackup,
    currentGitSha,
    fileSha256,
    openDatabase,
    parseArgs,
    readAuditReport,
    runCleanup,
    sameSha,
};
