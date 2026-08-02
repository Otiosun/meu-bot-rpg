#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildSquadMembershipIntegrityReport } = require('../helpers/clover/squadMembershipIntegrityAudit');

function parseArgs(argv) {
    const options = {
        db: './banco.sqlite',
        output: null,
        expectedAuditorSha: process.env.CLOVER_AUDITOR_SHA || null,
        runtimeSha: process.env.CLOVER_RUNTIME_SHA || null,
        failOnCritical: false,
        jsonOnly: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--db') options.db = argv[++index];
        else if (arg.startsWith('--db=')) options.db = arg.slice(5);
        else if (arg === '--output') options.output = argv[++index];
        else if (arg.startsWith('--output=')) options.output = arg.slice(9);
        else if (arg === '--expected-auditor-sha') options.expectedAuditorSha = argv[++index];
        else if (arg.startsWith('--expected-auditor-sha=')) options.expectedAuditorSha = arg.slice(23);
        else if (arg === '--runtime-sha') options.runtimeSha = argv[++index];
        else if (arg.startsWith('--runtime-sha=')) options.runtimeSha = arg.slice(14);
        else if (arg === '--fail-on-critical') options.failOnCritical = true;
        else if (arg === '--json-only') options.jsonOnly = true;
        else throw new Error(`Argumento desconhecido: ${arg}`);
    }
    return options;
}

function sameSha(left, right) {
    if (!left || !right) return null;
    const a = String(left).trim();
    const b = String(right).trim();
    return a.startsWith(b) || b.startsWith(a);
}

function defaultGitSha() {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: path.resolve(__dirname, '..'),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return null;
    }
}

function hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function fileEvidence(filePath, dependencies = {}) {
    const stat = await (dependencies.stat || fs.promises.stat)(filePath);
    const sha256 = await (dependencies.hashFile || hashFile)(filePath);
    return {
        path: path.resolve(filePath),
        size: Number(stat.size),
        mtimeMs: Number(stat.mtimeMs),
        sha256,
    };
}

async function defaultOpenReadOnly(filePath) {
    const sqlite3 = require('sqlite3').verbose();
    const { open } = require('sqlite');
    return open({ filename: filePath, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
}

function assertOutputAvailable(outputPath) {
    if (!outputPath) return;
    if (fs.existsSync(outputPath)) {
        const error = new Error('O relatório de auditoria já existe e não será sobrescrito.');
        error.code = 'membership_audit_output_exists';
        throw error;
    }
}

async function writePrivateJson(outputPath, payload, dependencies = {}) {
    if (!outputPath) return;
    await (dependencies.mkdir || fs.promises.mkdir)(path.dirname(path.resolve(outputPath)), { recursive: true });
    const handle = await (dependencies.openFile || fs.promises.open)(outputPath, 'wx', 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } finally {
        await handle.close();
    }
}

async function runAudit(options, dependencies = {}) {
    const dbPath = path.resolve(options.db || './banco.sqlite');
    const outputPath = options.output ? path.resolve(options.output) : null;
    const auditorSha = (dependencies.gitSha || defaultGitSha)();
    const shaMatches = sameSha(auditorSha, options.expectedAuditorSha);
    if (options.expectedAuditorSha && shaMatches !== true) {
        const error = new Error('O SHA do auditor não corresponde ao aprovado.');
        error.code = 'membership_audit_sha_mismatch';
        error.details = { expected: options.expectedAuditorSha, actual: auditorSha };
        throw error;
    }
    assertOutputAvailable(outputPath);

    const before = await fileEvidence(dbPath, dependencies);
    const openReadOnly = dependencies.openReadOnly || defaultOpenReadOnly;
    const db = await openReadOnly(dbPath);
    let report;
    try {
        await db.exec?.('PRAGMA query_only=ON');
        const queryOnly = await db.get('PRAGMA query_only');
        const enabled = Number(queryOnly?.query_only ?? queryOnly?.[Object.keys(queryOnly || {})[0]]) === 1;
        if (!enabled) {
            const error = new Error('SQLite não confirmou query_only=ON.');
            error.code = 'membership_audit_query_only_failed';
            throw error;
        }
        const reportBuilder = dependencies.reportBuilder || buildSquadMembershipIntegrityReport;
        report = await reportBuilder(db);
    } finally {
        await db.close?.();
    }

    const after = await fileEvidence(dbPath, dependencies);
    const immutable = before.sha256 === after.sha256
        && before.size === after.size
        && before.mtimeMs === after.mtimeMs;
    if (!immutable) {
        const error = new Error('O snapshot mudou durante a auditoria.');
        error.code = 'membership_audit_database_changed';
        error.details = { before, after };
        throw error;
    }

    const evidence = {
        kind: 'clover.squad-membership-integrity.v1',
        generatedAt: new Date().toISOString(),
        write: false,
        queryOnlySafe: true,
        auditor: {
            sha: auditorSha,
            expectedSha: options.expectedAuditorSha || null,
            shaMatches,
            runtimeSha: options.runtimeSha || null,
        },
        database: { before, after, immutable },
        report,
    };
    await writePrivateJson(outputPath, evidence, dependencies);
    return evidence;
}

async function main() {
    try {
        const options = parseArgs(process.argv.slice(2));
        const evidence = await runAudit(options);
        if (options.jsonOnly) console.log(JSON.stringify(evidence));
        else {
            console.log(JSON.stringify({
                ok: true,
                output: options.output || null,
                databaseSha256: evidence.database.before.sha256,
                criticalCount: evidence.report.summary.criticalCount,
                warningCount: evidence.report.summary.warningCount,
                canAdvance: evidence.report.summary.canAdvance,
            }, null, 2));
        }
        if (options.failOnCritical && evidence.report.summary.criticalCount > 0) process.exitCode = 2;
    } catch (error) {
        console.error(JSON.stringify({
            ok: false,
            error: error.code || 'membership_audit_failed',
            message: error.message,
            details: error.details || null,
        }, null, 2));
        process.exitCode = 1;
    }
}

if (require.main === module) main();

module.exports = {
    assertOutputAvailable,
    fileEvidence,
    hashFile,
    parseArgs,
    runAudit,
    sameSha,
    writePrivateJson,
};
