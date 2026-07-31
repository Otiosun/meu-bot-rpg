'use strict';

const fs = require('fs');
const path = require('path');
const {
    AUDITORS, EvidenceError, command, preflight, shaFile, shaText, validateConfig,
} = require('./phase0EvidenceCollectorConfig');

const out = (config, name) => path.join(config.outputDir, name);

function eligibilityArgs(config, snapshot, output) {
    const audit = config.auditors.eligibilityStatus;
    const args = [
        path.join(audit.cwd, AUDITORS.eligibilityStatus[0]),
        `--db=${snapshot}`,
        `--root=${config.runtime.cwd}`,
        `--expected-auditor-sha=${audit.expectedSha}`,
        `--output=${output}`,
    ];
    const policy = config.eligibilityPolicy;
    if (policy.approvedSheetStatuses.length) {
        policy.approvedSheetStatuses.forEach((value) => args.push(`--approved-sheet-status=${value}`));
        policy.releasedGameStatuses.forEach((value) => args.push(`--released-game-status=${value}`));
        args.push('--fail-on-policy-risk');
    }
    return args;
}

function buildPlan(config) {
    const snapshot = out(config, 'clover-phase0.snapshot.sqlite');
    const metadata = out(config, 'clover-phase0.snapshot.metadata.json');
    const phase0 = config.auditors.phase0;
    const role = config.auditors.roleShadow;
    const integrity = config.auditors.membershipIntegrity;
    const read = config.auditors.membershipReadShadow;
    const step = (name, cwd, args, outputs, accepted = [0, 2]) => ({ name, cwd, args, outputs, accepted });
    return {
        snapshot,
        metadata,
        steps: [
            step('create-snapshot', phase0.cwd, [
                path.join(phase0.cwd, AUDITORS.phase0[0]),
                `--db=${config.runtime.sourceDb}`,
                `--runtime-sha=${config.runtime.expectedSha}`,
                `--expected-auditor-sha=${phase0.expectedSha}`,
                `--output=${snapshot}`,
                `--metadata=${metadata}`,
            ], [snapshot, metadata], [0]),
            step('phase0-audit', phase0.cwd, [
                path.join(phase0.cwd, AUDITORS.phase0[1]),
                `--db=${snapshot}`,
                `--runtime-sha=${config.runtime.expectedSha}`,
                `--expected-auditor-sha=${phase0.expectedSha}`,
                `--output=${out(config, 'clover-phase0.audit.json')}`,
                '--fail-on-critical',
            ], [out(config, 'clover-phase0.audit.json')]),
            step('legacy-reconcile-callsites', phase0.cwd, [
                path.join(phase0.cwd, AUDITORS.phase0[2]),
                `--root=${config.runtime.cwd}`,
                `--output=${out(config, 'clover-phase0.reconcile-callsites.json')}`,
            ], [out(config, 'clover-phase0.reconcile-callsites.json')]),
            step('canonical-role-shadow', role.cwd, [
                path.join(role.cwd, AUDITORS.roleShadow[0]),
                `--db=${snapshot}`,
                `--expected-auditor-sha=${role.expectedSha}`,
                `--reference-date=${config.referenceDate}`,
                `--output=${out(config, 'clover-phase0.role-shadow.json')}`,
                '--fail-on-critical',
            ], [out(config, 'clover-phase0.role-shadow.json')]),
            step('membership-integrity', integrity.cwd, [
                path.join(integrity.cwd, AUDITORS.membershipIntegrity[0]),
                `--db=${snapshot}`,
                `--runtime-sha=${config.runtime.expectedSha}`,
                `--expected-auditor-sha=${integrity.expectedSha}`,
                `--output=${out(config, 'clover-phase0.membership-integrity.json')}`,
                '--fail-on-critical',
            ], [out(config, 'clover-phase0.membership-integrity.json')]),
            step('membership-read-shadow', read.cwd, [
                path.join(read.cwd, AUDITORS.membershipReadShadow[0]),
                `--db=${snapshot}`,
                `--expected-auditor-sha=${read.expectedSha}`,
                `--output=${out(config, 'clover-phase0.membership-read-shadow.json')}`,
                '--fail-on-unsafe',
            ], [out(config, 'clover-phase0.membership-read-shadow.json')]),
            step('membership-eligibility-statuses', config.auditors.eligibilityStatus.cwd,
                eligibilityArgs(config, snapshot, out(config, 'clover-phase0.membership-eligibility-statuses.json')),
                [out(config, 'clover-phase0.membership-eligibility-statuses.json')]),
        ],
    };
}

function privateWrite(file, value) {
    fs.writeFileSync(file, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}
function requireOutput(file) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new EvidenceError('Saída esperada ausente.', 'expected_output_missing', { file });
    }
    fs.chmodSync(file, 0o600);
}

async function run(config, options = {}, deps = {}) {
    validateConfig(config);
    const inspected = preflight(config, options.expectedCollectorSha, deps);
    const plan = buildPlan(config);
    if (options.dryRun) return { dryRun: true, plan, inspected };
    fs.mkdirSync(config.outputDir, { recursive: true, mode: 0o700 });
    const exec = deps.execute || ((item) => command(process.execPath, item.args, item.cwd));
    const completed = [];
    let snapshotState = null;
    try {
        for (const item of plan.steps) {
            const result = exec(item, { config, plan, completed });
            const code = Number.isInteger(result?.status) ? result.status : 1;
            const stdout = out(config, `${item.name}.stdout.log`);
            const stderr = out(config, `${item.name}.stderr.log`);
            privateWrite(stdout, String(result?.stdout || ''));
            privateWrite(stderr, String(result?.stderr || ''));
            if (!item.accepted.includes(code)) {
                throw new EvidenceError('Etapa falhou tecnicamente.', 'evidence_step_failed', { step: item.name, code });
            }
            item.outputs.forEach(requireOutput);
            const stat = fs.statSync(plan.snapshot);
            const hash = await shaFile(plan.snapshot);
            if (!snapshotState) snapshotState = { hash, size: stat.size, mtimeMs: stat.mtimeMs };
            else if (hash !== snapshotState.hash || stat.size !== snapshotState.size || stat.mtimeMs !== snapshotState.mtimeMs) {
                throw new EvidenceError('Snapshot mudou durante auditoria.', 'snapshot_changed_during_audit', { step: item.name });
            }
            completed.push({
                name: item.name,
                exitCode: code,
                classification: code === 2 ? 'evidence_blocked' : 'passed',
                outputs: item.outputs,
                stdout,
                stderr,
            });
        }
        const files = fs.readdirSync(config.outputDir).map((name) => path.join(config.outputDir, name));
        const artifacts = [];
        for (const file of files) {
            if (!fs.statSync(file).isFile()) continue;
            artifacts.push({ name: path.basename(file), bytes: fs.statSync(file).size, sha256: await shaFile(file) });
        }
        const blocked = completed.filter((item) => item.exitCode === 2).map((item) => item.name);
        const manifest = {
            version: 'clover.phase0-evidence-manifest.v1',
            generatedAt: new Date().toISOString(),
            status: blocked.length ? 'blocked_by_evidence' : 'passed',
            writeLiveDatabase: false,
            collector: inspected.collector,
            runtime: inspected.runtime,
            auditors: inspected.auditors,
            sourceDb: {
                path: config.runtime.sourceDb,
                bytes: fs.statSync(config.runtime.sourceDb).size,
                modifiedAt: fs.statSync(config.runtime.sourceDb).mtime.toISOString(),
            },
            snapshot: { path: plan.snapshot, sha256: snapshotState.hash, bytes: snapshotState.size, unchanged: true },
            referenceDate: config.referenceDate,
            eligibilityPolicy: config.eligibilityPolicy,
            configSha256: shaText(JSON.stringify(config)),
            blockedSteps: blocked,
            steps: completed,
            artifacts,
        };
        const manifestPath = out(config, 'clover-phase0.manifest.json');
        privateWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        const digestPath = out(config, 'clover-phase0.manifest.sha256');
        privateWrite(digestPath, `${await shaFile(manifestPath)}  ${path.basename(manifestPath)}\n`);
        return { ok: true, exitCode: blocked.length ? 2 : 0, manifestPath, digestPath, manifest };
    } catch (error) {
        const failure = out(config, 'clover-phase0.failure.json');
        if (!fs.existsSync(failure)) {
            privateWrite(failure, `${JSON.stringify({
                ok: false,
                error: error.code || 'phase0_evidence_failed',
                message: error.message,
                details: error.details || null,
                completed,
                writeLiveDatabase: false,
            }, null, 2)}\n`);
        }
        throw error;
    }
}

module.exports = { buildPlan, eligibilityArgs, run };
