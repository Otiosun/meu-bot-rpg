'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
    CanonicalRoleMigrationError,
    applyCanonicalRoleMigrationPlan,
    buildCanonicalRoleMigrationPlan,
    validateShadowEvidence,
} = require('../helpers/clover/canonicalRoleMigrationBatchService');

function parseArgs(argv) {
    const options = {
        db: './banco.sqlite',
        shadowReport: null,
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
        else if (arg === '--shadow-report') options.shadowReport = argv[++index];
        else if (arg.startsWith('--shadow-report=')) options.shadowReport = arg.slice(16);
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
        else throw new CanonicalRoleMigrationError(`Argumento desconhecido: ${arg}`, 'unknown_argument');
    }
    return options;
}

function sameSha(left, right) {
    if (!left || !right) return null;
    const a = String(left).trim();
    const b = String(right).trim();
    return a.startsWith(b) || b.startsWith(a);
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

function fileSha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

function validateApplyOptions(options = {}) {
    if (!options.apply) return;
    if (!String(options.output || '').trim()) {
        throw new CanonicalRoleMigrationError('O modo apply exige --output.', 'apply_output_required');
    }
    if (!String(options.backup || '').trim()) {
        throw new CanonicalRoleMigrationError('O modo apply exige --backup.', 'backup_required');
    }
    if (!String(options.actor || '').trim()) {
        throw new CanonicalRoleMigrationError('O modo apply exige --actor.', 'migration_actor_required');
    }
    if (String(options.reason || '').trim().replace(/\s+/g, ' ').length < 8) {
        throw new CanonicalRoleMigrationError('O modo apply exige --reason detalhado.', 'migration_reason_required');
    }
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
            throw new CanonicalRoleMigrationError('Não foi possível confirmar query_only.', 'query_only_not_enabled');
        }
    }
    return db;
}

function readJsonFile(filename, code) {
    if (!filename) throw new CanonicalRoleMigrationError('Informe --shadow-report.', 'shadow_report_required');
    const absolute = path.resolve(filename);
    if (!fs.existsSync(absolute)) {
        throw new CanonicalRoleMigrationError(`Arquivo não encontrado: ${absolute}`, code || 'file_not_found');
    }
    try {
        return { path: absolute, value: JSON.parse(fs.readFileSync(absolute, 'utf8')) };
    } catch (error) {
        throw new CanonicalRoleMigrationError('JSON inválido.', 'invalid_json_file', { message: error.message });
    }
}

async function createBackup(source, destination, expectedSha256) {
    const absolute = path.resolve(destination);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.copyFileSync(source, absolute, fs.constants.COPYFILE_EXCL);
    const sha256 = await fileSha256(absolute);
    if (sha256 !== expectedSha256) {
        throw new CanonicalRoleMigrationError('Backup divergente.', 'backup_hash_mismatch', {
            expectedSha256,
            actualSha256: sha256,
        });
    }
    return { path: absolute, sha256 };
}

async function runMigration(options, dependencies = {}) {
    validateApplyOptions(options);
    const resolveGitSha = dependencies.currentGitSha || currentGitSha;
    const digestFile = dependencies.fileSha256 || fileSha256;
    const open = dependencies.openDatabase || openDatabase;
    const backupCreator = dependencies.createBackup || createBackup;
    const runnerSha = resolveGitSha();
    const runnerMatch = sameSha(runnerSha, options.expectedRunnerSha);
    if (options.expectedRunnerSha && runnerMatch !== true) {
        throw new CanonicalRoleMigrationError('SHA do executor inesperado.', 'runner_sha_mismatch', {
            runnerSha,
            expectedRunnerSha: options.expectedRunnerSha,
        });
    }

    const absoluteDb = path.resolve(options.db);
    if (!fs.existsSync(absoluteDb)) {
        throw new CanonicalRoleMigrationError(`Banco não encontrado: ${absoluteDb}`, 'database_not_found');
    }
    const shadow = readJsonFile(options.shadowReport, 'shadow_report_not_found');
    const shadowReportSha256 = await digestFile(shadow.path);
    const statBefore = fs.statSync(absoluteDb);
    const hashBefore = await digestFile(absoluteDb);
    if (options.expectedDatabaseSha256 && options.expectedDatabaseSha256 !== hashBefore) {
        throw new CanonicalRoleMigrationError('Hash do banco inesperado.', 'database_sha256_mismatch', {
            expected: options.expectedDatabaseSha256,
            actual: hashBefore,
        });
    }
    const evidence = validateShadowEvidence(shadow.value, hashBefore);
    let backup = null;
    if (options.apply) backup = await backupCreator(absoluteDb, options.backup, hashBefore);

    const db = await open(absoluteDb, !options.apply);
    let plan;
    let applied = null;
    try {
        plan = await buildCanonicalRoleMigrationPlan(db, evidence);
        if (options.apply) {
            applied = await applyCanonicalRoleMigrationPlan(db, plan, {
                actor: options.actor,
                reason: options.reason,
                shadowReportSha256,
                shadowSubjectIds: evidence.subjectIds,
            });
        }
    } finally {
        await db.close().catch(() => null);
    }

    const statAfter = fs.statSync(absoluteDb);
    const hashAfter = await digestFile(absoluteDb);
    const unchanged = hashBefore === hashAfter
        && statBefore.size === statAfter.size
        && statBefore.mtimeMs === statAfter.mtimeMs;
    if (!options.apply && !unchanged) {
        throw new CanonicalRoleMigrationError('O banco mudou durante o dry-run.', 'database_changed_during_dry_run');
    }

    const report = {
        version: 'clover.canonical-role-migration.v1',
        generatedAt: new Date().toISOString(),
        write: Boolean(options.apply),
        mode: options.apply ? 'apply' : 'dry-run',
        runner: {
            sha: runnerSha,
            expectedSha: options.expectedRunnerSha || null,
            expectedMatch: runnerMatch,
        },
        database: {
            path: absoluteDb,
            sha256Before: hashBefore,
            sha256After: hashAfter,
            sizeBefore: statBefore.size,
            sizeAfter: statAfter.size,
            unchanged: !options.apply && unchanged,
        },
        shadowEvidence: {
            path: shadow.path,
            sha256: shadowReportSha256,
            referenceDate: evidence.referenceDate,
            subjectCount: evidence.subjectCount,
            approvedPolicyExpansionCount: evidence.approvedPolicyExpansionCount,
            approvedPolicyRestrictionCount: evidence.approvedPolicyRestrictionCount,
        },
        backup,
        plan: {
            safe: plan.safe,
            legacyAdminCount: plan.legacyAdminCount,
            legacyAccessCount: plan.legacyAccessCount,
            canonicalActiveCount: plan.canonicalActiveCount,
            plannedCount: plan.plannedCount,
            identities: plan.planned.map((item) => item.identity),
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
    const report = await runMigration(options);
    if (options.jsonOnly) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
        console.log('[role-migration] modo:', report.mode);
        console.log('[role-migration] planejados:', report.plan.plannedCount);
        console.log('[role-migration] banco antes:', report.database.sha256Before);
        console.log('[role-migration] banco depois:', report.database.sha256After);
        if (report.applied) console.log('[role-migration] lote:', report.applied.batchId);
        if (report.outputPath) console.log('[role-migration] relatório:', report.outputPath);
    }
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${JSON.stringify({
            ok: false,
            error: error.code || 'canonical_role_migration_failed',
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
    readJsonFile,
    runMigration,
    sameSha,
    validateApplyOptions,
};
