'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
    const options = {
        db: './banco.sqlite',
        output: null,
        root: path.resolve(__dirname, '..'),
        approvedSheetStatuses: [],
        releasedGameStatuses: [],
        expectedAuditorSha: process.env.CLOVER_AUDITOR_SHA || null,
        failOnPolicyRisk: false,
        jsonOnly: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--db') options.db = argv[++index];
        else if (arg.startsWith('--db=')) options.db = arg.slice(5);
        else if (arg === '--output') options.output = argv[++index];
        else if (arg.startsWith('--output=')) options.output = arg.slice(9);
        else if (arg === '--root') options.root = argv[++index];
        else if (arg.startsWith('--root=')) options.root = arg.slice(7);
        else if (arg === '--approved-sheet-status') options.approvedSheetStatuses.push(argv[++index]);
        else if (arg.startsWith('--approved-sheet-status=')) options.approvedSheetStatuses.push(arg.slice(24));
        else if (arg === '--released-game-status') options.releasedGameStatuses.push(argv[++index]);
        else if (arg.startsWith('--released-game-status=')) options.releasedGameStatuses.push(arg.slice(23));
        else if (arg === '--expected-auditor-sha') options.expectedAuditorSha = argv[++index];
        else if (arg.startsWith('--expected-auditor-sha=')) options.expectedAuditorSha = arg.slice(23);
        else if (arg === '--fail-on-policy-risk') options.failOnPolicyRisk = true;
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
    const db = await open({ filename, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
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

function scanStatusCallsites(root) {
    const terms = ['ficha_status', 'jogo_status', 'APPROVED_SHEET_STATUSES', 'RELEASED_GAME_STATUSES'];
    const extensions = new Set(['.js', '.cjs', '.mjs', '.ts']);
    const excluded = new Set(['.git', 'node_modules', 'backups', 'coverage']);
    const findings = [];
    const auditFiles = new Set([
        'helpers/clover/squadMembershipEligibilityStatusAudit.js',
        'scripts/auditSquadMembershipEligibilityStatuses.js',
        'tests/squadMembershipEligibilityStatusAuditContract.test.js',
        'tests/auditSquadMembershipEligibilityStatusesContract.test.js',
    ]);

    function visit(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (excluded.has(entry.name)) continue;
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(absolute);
            else if (extensions.has(path.extname(entry.name))) {
                const relativePath = path.relative(root, absolute).replace(/\\/g, '/');
                if (auditFiles.has(relativePath)) continue;
                const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
                lines.forEach((line, index) => {
                    const matchedTerms = terms.filter((term) => line.includes(term));
                    if (!matchedTerms.length) return;
                    findings.push({
                        path: relativePath,
                        line: index + 1,
                        matchedTerms,
                        text: line.trim().slice(0, 300),
                    });
                });
            }
        }
    }

    if (fs.existsSync(root)) visit(root);
    return findings.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}

async function runEligibilityStatusAudit(options, dependencies = {}) {
    const absoluteDb = path.resolve(options.db);
    const root = path.resolve(options.root || path.resolve(__dirname, '..'));
    const digestFile = dependencies.fileSha256 || fileSha256;
    const resolveGitSha = dependencies.currentGitSha || currentGitSha;
    const openDatabase = dependencies.openDatabase || openReadOnlyDatabase;
    const buildAudit = dependencies.buildAudit
        || require('../helpers/clover/squadMembershipEligibilityStatusAudit').buildEligibilityStatusAudit;
    const scanCallsites = dependencies.scanCallsites || scanStatusCallsites;

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
    let inventory;
    try {
        inventory = await buildAudit(db, {
            approvedSheetStatuses: options.approvedSheetStatuses,
            releasedGameStatuses: options.releasedGameStatuses,
        });
    } finally {
        await db.close().catch(() => null);
    }

    const statAfter = fs.statSync(absoluteDb);
    const hashAfter = await digestFile(absoluteDb);
    if (hashBefore !== hashAfter || statBefore.size !== statAfter.size || statBefore.mtimeMs !== statAfter.mtimeMs) {
        const error = new Error('O arquivo auditado mudou durante a leitura.');
        error.code = 'eligibility_status_audit_database_changed';
        throw error;
    }
    if (inventory?.write !== false || inventory?.queryOnlySafe !== true || inventory?.policyApplied !== false) {
        const error = new Error('O inventário não declarou as garantias de auditoria esperadas.');
        error.code = 'eligibility_status_audit_contract_invalid';
        throw error;
    }

    const report = {
        version: 'clover.squad-membership-eligibility-status-audit.v1',
        generatedAt: new Date().toISOString(),
        write: false,
        queryOnlySafe: true,
        policyApplied: false,
        database: {
            path: absoluteDb,
            sha256: hashAfter,
            sizeBytes: statAfter.size,
            unchanged: true,
        },
        auditor: {
            sha: auditorSha,
            expectedSha: options.expectedAuditorSha || null,
            expectedMatch,
        },
        codeUsage: scanCallsites(root),
        result: inventory,
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
    const report = await runEligibilityStatusAudit(options);
    if (options.jsonOnly) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
        console.log('[eligibility-status] banco preservado:', report.database.sha256);
        console.log('[eligibility-status] personagens:', report.result.summary.playerCount);
        console.log('[eligibility-status] membros existentes:', report.result.summary.existingMemberCount);
        console.log('[eligibility-status] candidatos:', report.result.summary.candidateCount);
        console.log('[eligibility-status] política simulada:', report.result.policy.evaluated);
        console.log('[eligibility-status] membros que falhariam:', report.result.summary.existingMemberFailureCount);
        if (report.outputPath) console.log('[eligibility-status] relatório:', report.outputPath);
    }
    if (options.failOnPolicyRisk && (
        report.result.policy.evaluated !== true
        || report.result.policy.safeForExistingMembers !== true
    )) process.exitCode = 2;
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${JSON.stringify({
            ok: false,
            error: error.code || 'eligibility_status_audit_failed',
            message: error.message,
            details: error.details || null,
        }, null, 2)}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    currentGitSha,
    fileSha256,
    openReadOnlyDatabase,
    parseArgs,
    runEligibilityStatusAudit,
    sameSha,
    scanStatusCallsites,
};
