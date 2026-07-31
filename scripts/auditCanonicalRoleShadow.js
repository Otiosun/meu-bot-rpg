'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
    const options = {
        db: './banco.sqlite',
        output: null,
        subjectIds: [],
        scopeKeys: [],
        referenceDate: null,
        expectedAuditorSha: process.env.CLOVER_AUDITOR_SHA || null,
        failOnCritical: false,
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
        else if (arg === '--reference-date') options.referenceDate = argv[++index];
        else if (arg.startsWith('--reference-date=')) options.referenceDate = arg.slice(17);
        else if (arg === '--expected-auditor-sha') options.expectedAuditorSha = argv[++index];
        else if (arg.startsWith('--expected-auditor-sha=')) options.expectedAuditorSha = arg.slice(23);
        else if (arg === '--fail-on-critical') options.failOnCritical = true;
        else if (arg === '--json-only') options.jsonOnly = true;
        else throw new Error(`Argumento desconhecido: ${arg}`);
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

async function openReadOnlyDatabase(filename) {
    const sqlite3 = require('sqlite3').verbose();
    const { open } = require('sqlite');
    const db = await open({
        filename,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });
    await db.exec('PRAGMA query_only = ON');
    const queryOnly = await db.get('PRAGMA query_only');
    if (Number(queryOnly?.query_only ?? Object.values(queryOnly || {})[0]) !== 1) {
        await db.close().catch(() => null);
        const error = new Error('Não foi possível confirmar PRAGMA query_only=ON.');
        error.code = 'query_only_not_enabled';
        throw error;
    }
    return db;
}

function normalizeReferenceDate(value) {
    if (!value) return new Date();
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        const error = new Error('Data de referência inválida.');
        error.code = 'invalid_reference_date';
        throw error;
    }
    return date;
}

async function runShadowAudit(options, dependencies = {}) {
    const openDatabase = dependencies.openDatabase || openReadOnlyDatabase;
    const buildBatch = dependencies.buildBatch
        || require('../helpers/clover/canonicalRoleShadowService').buildCanonicalRoleShadowBatch;
    const digestFile = dependencies.fileSha256 || fileSha256;
    const resolveGitSha = dependencies.currentGitSha || currentGitSha;
    const absoluteDb = path.resolve(options.db);
    if (!fs.existsSync(absoluteDb)) {
        const error = new Error(`Banco não encontrado: ${absoluteDb}`);
        error.code = 'database_not_found';
        throw error;
    }

    const statBefore = fs.statSync(absoluteDb);
    const hashBefore = await digestFile(absoluteDb);
    const auditorSha = resolveGitSha();
    const expectedMatch = sameSha(auditorSha, options.expectedAuditorSha);
    if (options.expectedAuditorSha && expectedMatch !== true) {
        const error = new Error('O SHA do auditor não corresponde ao SHA esperado.');
        error.code = 'auditor_sha_mismatch';
        error.details = { auditorSha, expectedAuditorSha: options.expectedAuditorSha };
        throw error;
    }

    const db = await openDatabase(absoluteDb);
    let batch;
    try {
        batch = await buildBatch(db, {
            subjectIds: options.subjectIds,
            scopeKeys: options.scopeKeys,
            referenceDate: normalizeReferenceDate(options.referenceDate),
        });
    } finally {
        await db.close().catch(() => null);
    }

    const statAfter = fs.statSync(absoluteDb);
    const hashAfter = await digestFile(absoluteDb);
    const unchanged = hashBefore === hashAfter
        && statBefore.size === statAfter.size
        && statBefore.mtimeMs === statAfter.mtimeMs;
    if (!unchanged) {
        const error = new Error('O arquivo auditado mudou durante a leitura.');
        error.code = 'shadow_audit_database_changed';
        error.details = {
            hashBefore,
            hashAfter,
            sizeBefore: statBefore.size,
            sizeAfter: statAfter.size,
            mtimeBefore: statBefore.mtimeMs,
            mtimeAfter: statAfter.mtimeMs,
        };
        throw error;
    }

    const report = {
        version: 'clover.canonical-role-shadow-audit.v1',
        generatedAt: new Date().toISOString(),
        write: false,
        queryOnlySafe: batch.queryOnlySafe === true,
        database: {
            path: absoluteDb,
            sizeBytes: statAfter.size,
            sha256: hashAfter,
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
            referenceDate: normalizeReferenceDate(options.referenceDate).toISOString(),
        },
        result: batch,
    };

    if (options.output) {
        const outputPath = path.resolve(options.output);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        report.outputPath = outputPath;
    }
    return report;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const report = await runShadowAudit(options);
    const serialized = JSON.stringify(report, null, 2);
    if (options.jsonOnly) process.stdout.write(`${serialized}\n`);
    else {
        console.log('[shadow-roles] banco preservado:', report.database.sha256);
        console.log('[shadow-roles] sujeitos:', report.result.subjectCount);
        console.log('[shadow-roles] divergentes:', report.result.divergentCount);
        console.log('[shadow-roles] críticos:', report.result.criticalCount);
        if (report.outputPath) console.log('[shadow-roles] relatório:', report.outputPath);
    }
    if (options.failOnCritical && report.result.criticalCount > 0) process.exitCode = 2;
}

if (require.main === module) {
    main().catch((error) => {
        const payload = {
            ok: false,
            error: error.code || 'shadow_audit_failed',
            message: error.message,
            details: error.details || null,
        };
        process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    currentGitSha,
    fileSha256,
    normalizeReferenceDate,
    openReadOnlyDatabase,
    parseArgs,
    runShadowAudit,
    sameSha,
};
