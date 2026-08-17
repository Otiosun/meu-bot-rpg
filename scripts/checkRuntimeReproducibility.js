'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readTrimmed(filePath) {
    return fs.readFileSync(filePath, 'utf8').trim();
}

function commandVersion(command, args = ['--version']) {
    const executable = process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command;
    const result = spawnSync(executable, args, {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
    });
    if (result.error || result.status !== 0) return null;
    return String(result.stdout || '').trim().replace(/^v/, '');
}

function gitHead(cwd = ROOT) {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
    });
    return !result.error && result.status === 0 ? String(result.stdout || '').trim() : null;
}

function assertCondition(condition, message, code = 'runtime_reproducibility_mismatch') {
    if (condition) return;
    const error = new Error(message);
    error.code = code;
    throw error;
}

function scanWorkflowJobs(workflowDir) {
    const files = fs.readdirSync(workflowDir)
        .filter((name) => /\.ya?ml$/i.test(name))
        .sort();
    const findings = [];
    let setupCount = 0;

    for (const name of files) {
        const source = fs.readFileSync(path.join(workflowDir, name), 'utf8');
        const lines = source.split(/\r?\n/);
        let inJobs = false;
        let currentJob = null;
        const jobs = new Map();

        lines.forEach((line, index) => {
            if (/^jobs:\s*$/.test(line)) {
                inJobs = true;
                currentJob = null;
                return;
            }
            if (!inJobs) return;

            const jobMatch = /^  ([A-Za-z0-9_.-]+):\s*$/.exec(line);
            if (jobMatch) {
                currentJob = jobMatch[1];
                jobs.set(currentJob, { setup: false, commands: [] });
                return;
            }
            if (!currentJob) return;

            const job = jobs.get(currentJob);
            if (/uses:\s*actions\/setup-node@/.test(line)) {
                job.setup = true;
                setupCount += 1;
            }
            const literalVersion = /node-version:\s*['"]?([^'"\s#]+)['"]?/.exec(line);
            if (literalVersion && !/^24(?:\.x)?$/.test(literalVersion[1])) {
                findings.push({ file: name, job: currentJob, line: index + 1, reason: 'noncanonical_node_major', value: literalVersion[1] });
            }
            if (/node-version-file:\s*/.test(line) && !/node-version-file:\s*['"]?\.node-version['"]?\s*$/.test(line.trim())) {
                findings.push({ file: name, job: currentJob, line: index + 1, reason: 'wrong_node_version_file' });
            }

            const trimmed = line.trim();
            const directRuntimeCommand = /\b(?:node|npm|npx)(?:\.cmd)?(?:\s|$)/.test(trimmed)
                && !/node-version|setup-node/.test(trimmed);
            if (directRuntimeCommand) job.commands.push({ line: index + 1, text: trimmed });
        });

        for (const [jobName, job] of jobs.entries()) {
            if (job.commands.length && !job.setup) {
                findings.push({
                    file: name,
                    job: jobName,
                    reason: 'runtime_command_without_setup_node',
                    commands: job.commands.slice(0, 3),
                });
            }
        }
    }

    return { files, findings, setupCount };
}

function validateSourceContracts(root = ROOT) {
    const manifest = readJson(path.join(root, 'config', 'runtime-reproducibility.json'));
    const nodeVersion = String(manifest.node?.version || '');
    assertCondition(/^\d+\.\d+\.\d+$/.test(nodeVersion), 'Versão Node canônica inválida.');
    assertCondition(Number(nodeVersion.split('.')[0]) === Number(manifest.node?.major), 'Major Node diverge do manifest.');
    assertCondition(readTrimmed(path.join(root, '.node-version')) === nodeVersion, '.node-version diverge do manifest.');
    assertCondition(readTrimmed(path.join(root, '.nvmrc')) === nodeVersion, '.nvmrc diverge do manifest.');

    const pkg = readJson(path.join(root, 'package.json'));
    const lock = readJson(path.join(root, 'package-lock.json'));
    assertCondition(Number(lock.lockfileVersion) === Number(manifest.package?.lockfileVersion), 'lockfileVersion diverge do manifest.');
    assertCondition(JSON.stringify(lock.packages?.['']?.dependencies || {}) === JSON.stringify(pkg.dependencies || {}), 'Dependências raiz do lockfile divergem do package.json.');

    const ecosystem = require(path.join(root, manifest.process.pm2Config));
    const app = Array.isArray(ecosystem?.apps)
        ? ecosystem.apps.find((item) => item?.name === manifest.process.pm2Name)
        : null;
    assertCondition(Boolean(app), `Processo PM2 ${manifest.process.pm2Name} não encontrado.`);
    assertCondition(app.script === manifest.process.entrypoint, 'Entrypoint PM2 diverge do manifest.');
    assertCondition(app.interpreter === process.execPath, 'PM2 deve herdar o mesmo executável Node via process.execPath.');

    const stackSource = fs.readFileSync(path.join(root, manifest.process.entrypoint), 'utf8');
    const childEscaped = manifest.process.childEntrypoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assertCondition(
        new RegExp(`spawnProcess\\(process\\.execPath, \\['${childEscaped}'\\]`).test(stackSource),
        'Stack principal não inicia o child com process.execPath + entrypoint canônico.'
    );

    const workflowScan = scanWorkflowJobs(path.join(root, '.github', 'workflows'));
    assertCondition(workflowScan.setupCount > 0, 'Nenhum setup-node encontrado nos workflows.');
    assertCondition(workflowScan.findings.length === 0, `Workflows não reproduzíveis: ${JSON.stringify(workflowScan.findings)}`);

    return { manifest, packageJson: pkg, packageLock: lock, workflowScan };
}

function buildRuntimeProvenance(options = {}) {
    const root = path.resolve(options.root || ROOT);
    const validated = validateSourceContracts(root);
    const expectedNode = validated.manifest.node.version;
    const expectedNpm = validated.manifest.node.npmVersion;
    const observedNode = process.versions.node;
    const observedNpm = commandVersion('npm');
    const exactRuntimeMatch = observedNode === expectedNode && observedNpm === expectedNpm;

    if (options.requireCurrentRuntime) {
        assertCondition(observedNode === expectedNode, `Node atual ${observedNode} != target ${expectedNode}.`, 'node_version_mismatch');
        assertCondition(observedNpm === expectedNpm, `npm atual ${observedNpm || '<indisponível>'} != target ${expectedNpm}.`, 'npm_version_mismatch');
    }

    const tracked = [
        '.node-version',
        '.nvmrc',
        'config/runtime-reproducibility.json',
        'package.json',
        'package-lock.json',
        validated.manifest.process.pm2Config,
        validated.manifest.process.entrypoint,
    ];
    const hashes = Object.fromEntries(tracked.map((relative) => [relative, sha256File(path.join(root, relative))]));

    return {
        schemaVersion: 1,
        sourceHead: gitHead(root),
        expected: { node: expectedNode, npm: expectedNpm },
        observed: { node: observedNode, npm: observedNpm },
        exactRuntimeMatch,
        lockfileVersion: validated.packageLock.lockfileVersion,
        workflowFiles: validated.workflowScan.files.length,
        setupNodeUsages: validated.workflowScan.setupCount,
        hashes,
    };
}

function runCli() {
    const requireCurrentRuntime = process.argv.includes('--require-current-runtime');
    const provenance = buildRuntimeProvenance({ requireCurrentRuntime });
    console.log(JSON.stringify(provenance, null, 2));
}

if (require.main === module) {
    try {
        runCli();
    } catch (error) {
        console.error(`[runtime-reproducibility] ${error.code || 'error'}: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    buildRuntimeProvenance,
    scanWorkflowJobs,
    validateSourceContracts,
};
