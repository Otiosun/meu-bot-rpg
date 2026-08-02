'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const {
    backupSqliteDatabase,
} = require('../helpers/clover/sqliteBackupService');
const {
    runRuntimeReadAudit,
    sameSha,
} = require('./auditCanonicalRoleRuntimeReadShadow');

class CanonicalRoleRuntimeReadCaptureError extends Error {
    constructor(message, code = 'canonical_role_runtime_read_capture_failed', details = null) {
        super(message || code);
        this.name = 'CanonicalRoleRuntimeReadCaptureError';
        this.code = code;
        this.details = details;
    }
}

function parseArgs(argv) {
    const options = {
        db: null,
        snapshot: null,
        metadata: null,
        report: null,
        runtimeRepo: null,
        expectedRuntimeSha: null,
        expectedAuditorSha: process.env.CLOVER_AUDITOR_SHA || null,
        referenceDate: null,
        failOnUnsafe: false,
        jsonOnly: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--db') options.db = argv[++index];
        else if (arg.startsWith('--db=')) options.db = arg.slice(5);
        else if (arg === '--snapshot') options.snapshot = argv[++index];
        else if (arg.startsWith('--snapshot=')) options.snapshot = arg.slice(11);
        else if (arg === '--metadata') options.metadata = argv[++index];
        else if (arg.startsWith('--metadata=')) options.metadata = arg.slice(11);
        else if (arg === '--report') options.report = argv[++index];
        else if (arg.startsWith('--report=')) options.report = arg.slice(9);
        else if (arg === '--runtime-repo') options.runtimeRepo = argv[++index];
        else if (arg.startsWith('--runtime-repo=')) options.runtimeRepo = arg.slice(15);
        else if (arg === '--expected-runtime-sha') options.expectedRuntimeSha = argv[++index];
        else if (arg.startsWith('--expected-runtime-sha=')) options.expectedRuntimeSha = arg.slice(23);
        else if (arg === '--expected-auditor-sha') options.expectedAuditorSha = argv[++index];
        else if (arg.startsWith('--expected-auditor-sha=')) options.expectedAuditorSha = arg.slice(23);
        else if (arg === '--reference-date') options.referenceDate = argv[++index];
        else if (arg.startsWith('--reference-date=')) options.referenceDate = arg.slice(17);
        else if (arg === '--fail-on-unsafe') options.failOnUnsafe = true;
        else if (arg === '--json-only') options.jsonOnly = true;
        else {
            throw new CanonicalRoleRuntimeReadCaptureError(
                `Argumento desconhecido: ${arg}`,
                'unknown_argument',
                { argument: arg }
            );
        }
    }

    for (const field of ['db', 'snapshot', 'metadata', 'report', 'runtimeRepo']) {
        if (!String(options[field] || '').trim()) {
            throw new CanonicalRoleRuntimeReadCaptureError(
                `Informe --${field.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}.`,
                'required_argument_missing',
                { field }
            );
        }
    }
    return options;
}

function git(cwd, args, options = {}) {
    const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (options.allowFailure) return result;
    if (result.status !== 0) {
        throw new CanonicalRoleRuntimeReadCaptureError(
            `Falha no Git: git ${args.join(' ')}`,
            'git_command_failed',
            { cwd, status: result.status, stderr: String(result.stderr || '').trim() }
        );
    }
    return String(result.stdout || '').trim();
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
        const input = fs.createReadStream(filePath);
        input.on('data', (chunk) => hash.update(chunk));
        input.on('error', reject);
        input.on('end', () => resolve(hash.digest('hex')));
    });
}

function isInside(childPath, parentPath) {
    const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertExclusiveOutputs(paths) {
    const normalized = paths.map((entry) => path.resolve(entry));
    if (new Set(normalized).size !== normalized.length) {
        throw new CanonicalRoleRuntimeReadCaptureError(
            'Snapshot, metadados e relatório devem usar caminhos diferentes.',
            'output_paths_overlap'
        );
    }
    for (const outputPath of normalized) {
        if (fs.existsSync(outputPath)) {
            throw new CanonicalRoleRuntimeReadCaptureError(
                `A saída já existe: ${outputPath}`,
                'output_already_exists',
                { path: outputPath }
            );
        }
    }
}

function inspectRepository(repoPath, expectedSha, label) {
    const absolute = path.resolve(repoPath);
    if (!fs.existsSync(absolute)) {
        throw new CanonicalRoleRuntimeReadCaptureError(
            `${label} ausente: ${absolute}`,
            'repository_not_found',
            { label, path: absolute }
        );
    }
    const sha = git(absolute, ['rev-parse', 'HEAD']);
    const expectedMatch = sameSha(sha, expectedSha);
    if (expectedSha && expectedMatch !== true) {
        throw new CanonicalRoleRuntimeReadCaptureError(
            `${label} está em SHA inesperado.`,
            'repository_sha_mismatch',
            { label, sha, expectedSha }
        );
    }
    const tracked = git(absolute, ['status', '--porcelain', '--untracked-files=no']);
    if (tracked) {
        throw new CanonicalRoleRuntimeReadCaptureError(
            `${label} possui alterações rastreadas.`,
            'repository_tracked_changes',
            { label, changes: tracked.split(/\r?\n/) }
        );
    }
    return {
        path: absolute,
        sha,
        expectedSha: expectedSha || null,
        expectedMatch,
        trackedClean: true,
    };
}

function writeJsonExclusive(filename, value) {
    const absolute = path.resolve(filename);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
    });
    return absolute;
}

async function runCapture(options, dependencies = {}) {
    const backup = dependencies.backupSqliteDatabase || backupSqliteDatabase;
    const audit = dependencies.runRuntimeReadAudit || runRuntimeReadAudit;
    const digestFile = dependencies.fileSha256 || fileSha256;
    const inspectRepo = dependencies.inspectRepository || inspectRepository;
    const auditorRepo = path.resolve(__dirname, '..');
    const sourceDb = path.resolve(options.db);
    const snapshot = path.resolve(options.snapshot);
    const metadata = path.resolve(options.metadata);
    const reportPath = path.resolve(options.report);
    const runtimeRepo = path.resolve(options.runtimeRepo);

    if (!fs.existsSync(sourceDb)) {
        throw new CanonicalRoleRuntimeReadCaptureError(
            `Banco vivo não encontrado: ${sourceDb}`,
            'database_not_found',
            { path: sourceDb }
        );
    }
    if (!isInside(sourceDb, runtimeRepo)) {
        throw new CanonicalRoleRuntimeReadCaptureError(
            'O banco informado não está dentro do runtime confirmado.',
            'database_outside_runtime',
            { sourceDb, runtimeRepo }
        );
    }
    for (const outputPath of [snapshot, metadata, reportPath]) {
        if (isInside(outputPath, runtimeRepo) || isInside(outputPath, auditorRepo)) {
            throw new CanonicalRoleRuntimeReadCaptureError(
                'As saídas privadas devem ficar fora do runtime e do worktree auditor.',
                'output_inside_repository',
                { outputPath }
            );
        }
    }
    assertExclusiveOutputs([snapshot, metadata, reportPath]);

    const runtime = inspectRepo(runtimeRepo, options.expectedRuntimeSha, 'runtime');
    const auditor = inspectRepo(auditorRepo, options.expectedAuditorSha, 'auditor');

    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    const backupResult = await backup(sourceDb, snapshot);
    const snapshotSha256 = await digestFile(snapshot);
    const snapshotStat = fs.statSync(snapshot);

    const report = await audit({
        db: snapshot,
        output: reportPath,
        subjectIds: [],
        scopeKeys: [],
        permissions: [],
        referenceDate: options.referenceDate,
        expectedAuditorSha: auditor.sha,
        expectedDatabaseSha256: snapshotSha256,
        failOnUnsafe: false,
        jsonOnly: false,
    });

    const metadataValue = {
        version: 'clover.canonical-role-runtime-read-capture.v1',
        generatedAt: new Date().toISOString(),
        writeToSource: false,
        sourceOpenedReadOnly: true,
        runtime,
        auditor,
        source: {
            path: sourceDb,
        },
        snapshot: {
            path: snapshot,
            sha256: snapshotSha256,
            sizeBytes: snapshotStat.size,
            integrity: backupResult.integrity,
            method: backupResult.method,
        },
        report: {
            path: report.outputPath || reportPath,
            version: report.version,
            databaseSha256: report.database.sha256,
            safeForAdminReader: report.safety.safeForAdminReader,
            safeForScopedAccessReader: report.safety.safeForScopedAccessReader,
            safeForGenericAccessReader: report.safety.safeForGenericAccessReader,
            safeToSwitchAllRuntimeReaders: report.safety.safeToSwitchAllRuntimeReaders,
        },
    };
    const metadataPath = writeJsonExclusive(metadata, metadataValue);

    return {
        version: metadataValue.version,
        snapshot: metadataValue.snapshot,
        report: {
            ...metadataValue.report,
            safety: report.safety,
        },
        metadataPath,
        runtime,
        auditor,
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const result = await runCapture(options);
    if (options.jsonOnly) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
        console.log('[runtime-role-capture] snapshot:', result.snapshot.path);
        console.log('[runtime-role-capture] SHA-256:', result.snapshot.sha256);
        console.log('[runtime-role-capture] integridade:', result.snapshot.integrity);
        console.log('[runtime-role-capture] relatório:', result.report.path);
        console.log('[runtime-role-capture] Central ADM segura:', result.report.safeForAdminReader);
        console.log('[runtime-role-capture] acesso escopado seguro:', result.report.safeForScopedAccessReader);
        console.log('[runtime-role-capture] acesso genérico seguro:', result.report.safeForGenericAccessReader);
        console.log('[runtime-role-capture] troca total segura:', result.report.safeToSwitchAllRuntimeReaders);
        console.log('[runtime-role-capture] metadados:', result.metadataPath);
    }
    if (options.failOnUnsafe && !result.report.safeToSwitchAllRuntimeReaders) {
        process.exitCode = 2;
    }
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${JSON.stringify({
            ok: false,
            error: error.code || 'canonical_role_runtime_read_capture_failed',
            message: error.message,
            details: error.details || null,
        }, null, 2)}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    CanonicalRoleRuntimeReadCaptureError,
    assertExclusiveOutputs,
    currentGitSha,
    fileSha256,
    git,
    inspectRepository,
    isInside,
    parseArgs,
    runCapture,
    writeJsonExclusive,
};