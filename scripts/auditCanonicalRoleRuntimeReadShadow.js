'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

class CanonicalRoleRuntimeReadAuditError extends Error {
    constructor(message, code = 'canonical_role_runtime_read_audit_failed', details = null) {
        super(message || code);
        this.name = 'CanonicalRoleRuntimeReadAuditError';
        this.code = code;
        this.details = details;
    }
}

function parseArgs(argv) {
    const options = {
        db: './banco.sqlite',
        output: null,
        subjectIds: [],
        scopeKeys: [],
        permissions: [],
        referenceDate: null,
        expectedAuditorSha: process.env.CLOVER_AUDITOR_SHA || null,
        expectedDatabaseSha256: null,
        failOnUnsafe: false,
        jsonOnly: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--db') options.db = argv[++index];
        else if (arg.startsWith('--db=')) options.db = arg.slice(5);
        else if (arg === '--output') options.output = argv[++index];
        else if (arg.startsWith('--output=')) options.output = arg.slice(9);
        else if (arg === '--subject') options.subjectIds.push(argv[++index]);
        else if (arg.startsWith('--subject=')) options.subjectIds.push(arg.slice(10));
        else if (arg === '--scope') options.scopeKeys.push(argv[++index]);
        else if (arg.startsWith('--scope=')) options.scopeKeys.push(arg.slice(8));
        else if (arg === '--permission') options.permissions.push(argv[++index]);
        else if (arg.startsWith('--permission=')) options.permissions.push(arg.slice(13));
        else if (arg === '--reference-date') options.referenceDate = argv[++index];
        else if (arg.startsWith('--reference-date=')) options.referenceDate = arg.slice(17);
        else if (arg === '--expected-auditor-sha') options.expectedAuditorSha = argv[++index];
        else if (arg.startsWith('--expected-auditor-sha=')) options.expectedAuditorSha = arg.slice(23);
        else if (arg === '--expected-db-sha256') options.expectedDatabaseSha256 = argv[++index];
        else if (arg.startsWith('--expected-db-sha256=')) options.expectedDatabaseSha256 = arg.slice(21);
        else if (arg === '--fail-on-unsafe') options.failOnUnsafe = true;
        else if (arg === '--json-only') options.jsonOnly = true;
        else {
            throw new CanonicalRoleRuntimeReadAuditError(
                `Argumento desconhecido: ${arg}`,
                'unknown_argument',
                { argument: arg }
            );
        }
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
    const actual = String(left).trim().toLowerCase();
    const expected = String(right).trim().toLowerCase();
    return actual.startsWith(expected) || expected.startsWith(actual);
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

function normalizeReferenceDate(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) {
        throw new CanonicalRoleRuntimeReadAuditError(
            'Data de referência inválida.',
            'invalid_reference_date',
            { value: value || null }
        );
    }
    return date;
}

async function openReadOnlyDatabase(filename) {
    const sqlite3 = require('sqlite3').verbose();
    const { open } = require('sqlite');
    const db = await open({
        filename,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });
    await db.exec('PRAGMA busy_timeout = 10000');
    await db.exec('PRAGMA query_only = ON');
    const queryOnly = await db.get('PRAGMA query_only');
    if (Number(queryOnly?.query_only ?? Object.values(queryOnly || {})[0]) !== 1) {
        await db.close().catch(() => null);
        throw new CanonicalRoleRuntimeReadAuditError(
            'Não foi possível confirmar PRAGMA query_only=ON.',
            'query_only_not_enabled'
        );
    }
    return db;
}

function validateBatchContract(batch) {
    const errors = [];
    if (batch?.version !== 'clover.canonical-role-runtime-read-shadow-batch.v2') {
        errors.push('unexpected_batch_version');
    }
    if (batch?.write !== false) errors.push('batch_not_read_only');
    if (batch?.queryOnlySafe !== true) errors.push('batch_not_query_only_safe');
    if (batch?.enforcementChanged !== false) errors.push('batch_changed_enforcement');
    if (!Number.isInteger(batch?.subjectCount) || batch.subjectCount <= 0) {
        errors.push('batch_has_no_subjects');
    }
    if (!Array.isArray(batch?.reports) || batch.reports.length !== batch.subjectCount) {
        errors.push('batch_subject_count_mismatch');
    }
    if ((batch?.reports || []).some((report) => (
        report?.version !== 'clover.canonical-role-runtime-read-shadow.v2'
        || report?.write !== false
        || report?.queryOnlySafe !== true
        || report?.enforcementChanged !== false
        || !Array.isArray(report?.catalogs?.admin)
        || !Array.isArray(report?.catalogs?.access)
    ))) {
        errors.push('report_contract_violation');
    }
    if (errors.length) {
        throw new CanonicalRoleRuntimeReadAuditError(
            'O batch de shadow não cumpriu o contrato read-only por superfície.',
            'invalid_runtime_read_shadow_batch',
            { errors }
        );
    }
}

function summarizeSafety(batch) {
    const subjectCount = Number(batch.subjectCount || 0);
    const unsafeAdminSubjects = batch.reports
        .filter((report) => report?.summary?.safeForAdminReader !== true)
        .map((report) => report.subjectId);
    const unsafeScopedAccessSubjects = batch.reports
        .filter((report) => report?.summary?.safeForScopedAccessReader !== true)
        .map((report) => report.subjectId);
    const unsafeGenericAccessSubjects = batch.reports
        .filter((report) => report?.summary?.safeForGenericAccessReader !== true)
        .map((report) => report.subjectId);
    const unsafeAllSubjects = batch.reports
        .filter((report) => report?.summary?.safeToSwitchAllRuntimeReaders !== true)
        .map((report) => report.subjectId);

    return {
        subjectCount,
        safeForAdminReader: unsafeAdminSubjects.length === 0,
        safeForScopedAccessReader: unsafeScopedAccessSubjects.length === 0,
        safeForGenericAccessReader: unsafeGenericAccessSubjects.length === 0,
        safeToSwitchAllRuntimeReaders: unsafeAllSubjects.length === 0,
        unsafeAdminSubjects,
        unsafeScopedAccessSubjects,
        unsafeGenericAccessSubjects,
        unsafeAllSubjects,
        adminCriticalCount: Number(batch.adminCriticalCount || 0),
        accessGenericCriticalCount: Number(batch.accessGenericCriticalCount || 0),
        accessScopedCriticalCount: Number(batch.accessScopedCriticalCount || 0),
        genericScopeHardeningCount: Number(batch.genericScopeHardeningCount || 0),
        foreignScopeLeakCount: Number(batch.foreignScopeLeakCount || 0),
    };
}

async function runRuntimeReadAudit(options, dependencies = {}) {
    const openDatabase = dependencies.openDatabase || openReadOnlyDatabase;
    const buildBatch = dependencies.buildBatch
        || require('../helpers/clover/canonicalRoleRuntimeReadShadowService')
            .buildCanonicalRoleRuntimeReadShadowBatch;
    const digestFile = dependencies.fileSha256 || fileSha256;
    const resolveGitSha = dependencies.currentGitSha || currentGitSha;

    const absoluteDb = path.resolve(options.db);
    if (!fs.existsSync(absoluteDb)) {
        throw new CanonicalRoleRuntimeReadAuditError(
            `Banco não encontrado: ${absoluteDb}`,
            'database_not_found',
            { path: absoluteDb }
        );
    }

    const auditorSha = resolveGitSha();
    const expectedMatch = sameSha(auditorSha, options.expectedAuditorSha);
    if (options.expectedAuditorSha && expectedMatch !== true) {
        throw new CanonicalRoleRuntimeReadAuditError(
            'O SHA do auditor não corresponde ao SHA esperado.',
            'auditor_sha_mismatch',
            { auditorSha, expectedAuditorSha: options.expectedAuditorSha }
        );
    }

    const statBefore = fs.statSync(absoluteDb);
    const hashBefore = await digestFile(absoluteDb);
    if (options.expectedDatabaseSha256
        && String(options.expectedDatabaseSha256).toLowerCase() !== hashBefore.toLowerCase()) {
        throw new CanonicalRoleRuntimeReadAuditError(
            'O SHA-256 do banco não corresponde ao esperado.',
            'database_sha256_mismatch',
            {
                expectedDatabaseSha256: options.expectedDatabaseSha256,
                actualDatabaseSha256: hashBefore,
            }
        );
    }

    const referenceDate = normalizeReferenceDate(options.referenceDate);
    const db = await openDatabase(absoluteDb);
    let batch;
    try {
        batch = await buildBatch(db, {
            subjectIds: options.subjectIds || [],
            scopeKeys: options.scopeKeys || [],
            permissions: options.permissions || [],
            referenceDate,
        });
    } finally {
        await db.close().catch(() => null);
    }

    validateBatchContract(batch);

    const statAfter = fs.statSync(absoluteDb);
    const hashAfter = await digestFile(absoluteDb);
    const unchanged = hashBefore === hashAfter
        && statBefore.size === statAfter.size
        && statBefore.mtimeMs === statAfter.mtimeMs;
    if (!unchanged) {
        throw new CanonicalRoleRuntimeReadAuditError(
            'O arquivo auditado mudou durante a leitura.',
            'runtime_read_shadow_database_changed',
            {
                hashBefore,
                hashAfter,
                sizeBefore: statBefore.size,
                sizeAfter: statAfter.size,
                mtimeBefore: statBefore.mtimeMs,
                mtimeAfter: statAfter.mtimeMs,
            }
        );
    }

    const safety = summarizeSafety(batch);
    const report = {
        version: 'clover.canonical-role-runtime-read-audit.v2',
        generatedAt: new Date().toISOString(),
        write: false,
        queryOnlySafe: true,
        enforcementChanged: false,
        database: {
            path: absoluteDb,
            sha256: hashAfter,
            sizeBytes: statAfter.size,
            mtimeMs: statAfter.mtimeMs,
            unchanged: true,
        },
        auditor: {
            sha: auditorSha,
            expectedSha: options.expectedAuditorSha || null,
            expectedMatch,
        },
        filters: {
            subjectIds: options.subjectIds || [],
            scopeKeys: options.scopeKeys || [],
            permissions: options.permissions || [],
            referenceDate: referenceDate.toISOString(),
        },
        safety,
        result: batch,
    };

    if (options.output) {
        const outputPath = path.resolve(options.output);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
        });
        report.outputPath = outputPath;
    }

    return report;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const report = await runRuntimeReadAudit(options);
    if (options.jsonOnly) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
        console.log('[runtime-role-shadow] snapshot preservado:', report.database.sha256);
        console.log('[runtime-role-shadow] sujeitos:', report.safety.subjectCount);
        console.log('[runtime-role-shadow] Central ADM segura:', report.safety.safeForAdminReader);
        console.log('[runtime-role-shadow] acesso escopado seguro:', report.safety.safeForScopedAccessReader);
        console.log('[runtime-role-shadow] acesso genérico seguro:', report.safety.safeForGenericAccessReader);
        console.log('[runtime-role-shadow] troca total segura:', report.safety.safeToSwitchAllRuntimeReaders);
        console.log('[runtime-role-shadow] hardening genérico:', report.safety.genericScopeHardeningCount);
        console.log('[runtime-role-shadow] vazamentos estrangeiros:', report.safety.foreignScopeLeakCount);
        if (report.outputPath) console.log('[runtime-role-shadow] relatório:', report.outputPath);
    }
    if (options.failOnUnsafe && !report.safety.safeToSwitchAllRuntimeReaders) {
        process.exitCode = 2;
    }
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${JSON.stringify({
            ok: false,
            error: error.code || 'canonical_role_runtime_read_audit_failed',
            message: error.message,
            details: error.details || null,
        }, null, 2)}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    CanonicalRoleRuntimeReadAuditError,
    currentGitSha,
    fileSha256,
    normalizeReferenceDate,
    openReadOnlyDatabase,
    parseArgs,
    runRuntimeReadAudit,
    sameSha,
    summarizeSafety,
    validateBatchContract,
};