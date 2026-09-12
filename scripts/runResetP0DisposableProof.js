'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MIN_FREE_BYTES = 1024 * 1024 * 1024;
const DANGEROUS_ENV_KEYS = Object.freeze([
    'PRE_RESET_LAUNCH_ENABLED',
    'CLOVER_GLOBAL_RESET_ENABLED',
    'CLOVER_GLOBAL_RESET_RECOVER_EXECUTION',
    'CLOVER_RESET_EXECUTION_AUTHORIZED',
]);

function fail(message, code) {
    const error = new Error(message);
    error.code = code;
    throw error;
}

function parseArgs(argv = process.argv.slice(2)) {
    const result = { expectedHead: null, output: null };
    for (const arg of argv) {
        if (arg.startsWith('--expected-head=')) result.expectedHead = arg.slice('--expected-head='.length).trim();
        else if (arg.startsWith('--output=')) result.output = arg.slice('--output='.length).trim();
        else fail(`Argumento desconhecido: ${arg}`, 'local_proof_unknown_argument');
    }
    if (!/^[a-f0-9]{40}$/i.test(result.expectedHead || '')) {
        fail('--expected-head=<SHA40> é obrigatório.', 'local_proof_expected_head_required');
    }
    return result;
}

function loadCanonicalNodeVersion(root = ROOT) {
    const versionPath = path.join(root, '.node-version');
    if (!fs.existsSync(versionPath)) {
        fail(`Arquivo canônico de Node ausente: ${versionPath}`, 'local_proof_node_version_file_missing');
    }
    const version = fs.readFileSync(versionPath, 'utf8').trim().replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        fail(`.node-version inválido: ${version || '<vazio>'}`, 'local_proof_node_version_file_invalid');
    }
    return version;
}

function assertCanonicalNodeVersion(currentVersion, canonicalVersion) {
    const current = String(currentVersion || '').trim().replace(/^v/, '');
    const canonical = String(canonicalVersion || '').trim().replace(/^v/, '');
    if (current !== canonical) {
        fail(
            `Node divergente do projeto. Esperado ${canonical}, observado ${current || '<vazio>'}.`,
            'local_proof_node_version_mismatch'
        );
    }
    return true;
}

function isEnabled(value) {
    return ['1', 'TRUE', 'YES', 'ON', 'ENABLED'].includes(String(value || '').trim().toUpperCase());
}

function assertSafeEnvironment(env = process.env) {
    const enabled = DANGEROUS_ENV_KEYS.filter((key) => isEnabled(env[key]));
    if (enabled.length) {
        fail(`Flags destrutivas/ativação ligadas no shell: ${enabled.join(', ')}`, 'local_proof_unsafe_environment');
    }
    return true;
}

function safeChildEnv(env = process.env) {
    const child = { ...env, NODE_ENV: 'test' };
    delete child.PRE_RESET_LAUNCH_ENABLED;
    delete child.PRE_RESET_FRONTEND_INTEGRATED;
    delete child.CLOVER_GLOBAL_RESET_ENABLED;
    delete child.CLOVER_GLOBAL_RESET_OPERATION_ID;
    delete child.CLOVER_GLOBAL_RESET_RECOVER_EXECUTION;
    delete child.CLOVER_RESET_EXECUTION_AUTHORIZED;
    return child;
}

function gitText(args) {
    const run = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', shell: false });
    if (run.error || run.status !== 0) {
        fail(`Git falhou: ${run.error?.message || run.stderr || args.join(' ')}`, 'local_proof_git_failed');
    }
    return String(run.stdout || '').trim();
}

function assertGitPreflight(expectedHead) {
    const head = gitText(['rev-parse', 'HEAD']);
    if (head.toLowerCase() !== expectedHead.toLowerCase()) {
        fail(`HEAD divergente. Esperado ${expectedHead}, observado ${head}.`, 'local_proof_head_mismatch');
    }
    const status = gitText(['status', '--porcelain=v1', '--untracked-files=all']);
    if (status) fail('Worktree precisa estar limpo antes da prova local.', 'local_proof_dirty_worktree');
    return { head, status: 'clean' };
}

function freeBytesAtRoot() {
    if (typeof fs.statfsSync !== 'function') return null;
    const stats = fs.statfsSync(ROOT);
    return Number(stats.bavail) * Number(stats.bsize);
}

function defaultOutputPath() {
    const desktop = path.join(os.homedir(), 'Desktop');
    const directory = fs.existsSync(desktop) ? desktop : os.tmpdir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(directory, `CLOVER_RESET_P0_PROOF_${stamp}.txt`);
}

function extractSummary(output) {
    const keys = [
        'P0_PASS',
        'P0_PROGRESS_PERCENT',
        'PRE_RESET_MODE_DEFAULT_OFF',
        'PRE_RESET_CURRENTLY_OFF',
        'GLOBAL_RESET_MUTATION_SWITCH_OFF',
        'ACTIVATION_AUTHORIZED',
        'RESET_GO_NO_GO',
    ];
    return Object.fromEntries(keys.map((key) => {
        const matches = [...String(output).matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))];
        return [key, matches.length ? matches.at(-1)[1].trim() : null];
    }));
}

function assertTechnicalProofSummary(summary) {
    const expected = {
        P0_PASS: '14/14',
        P0_PROGRESS_PERCENT: '100',
        PRE_RESET_MODE_DEFAULT_OFF: 'YES',
        PRE_RESET_CURRENTLY_OFF: 'YES',
        GLOBAL_RESET_MUTATION_SWITCH_OFF: 'YES',
        ACTIVATION_AUTHORIZED: 'NO',
        RESET_GO_NO_GO: 'NO_GO',
    };
    const mismatches = Object.entries(expected)
        .filter(([key, value]) => summary[key] !== value)
        .map(([key, value]) => `${key}: esperado ${value}, observado ${summary[key] ?? 'AUSENTE'}`);
    if (mismatches.length) {
        fail(`Prova P0 local não fechou: ${mismatches.join('; ')}`, 'local_proof_summary_failed');
    }
    return true;
}

function runAndTee(executable, args, options, write) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, options);
        let combined = '';
        const onData = (stream) => (chunk) => {
            const text = chunk.toString();
            combined += text;
            write(text);
            stream.write(text);
        };
        child.stdout.on('data', onData(process.stdout));
        child.stderr.on('data', onData(process.stderr));
        child.on('error', reject);
        child.on('close', (code, signal) => resolve({ code, signal, combined }));
    });
}

async function main() {
    const args = parseArgs();
    const canonicalNodeVersion = loadCanonicalNodeVersion();
    assertCanonicalNodeVersion(process.version, canonicalNodeVersion);
    assertSafeEnvironment();
    const git = assertGitPreflight(args.expectedHead);
    const freeBytes = freeBytesAtRoot();
    if (freeBytes !== null && freeBytes < MIN_FREE_BYTES) {
        fail(`Espaço livre insuficiente para a prova descartável: ${freeBytes} bytes.`, 'local_proof_low_disk');
    }

    const outputPath = path.resolve(args.output || defaultOutputPath());
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (fs.existsSync(outputPath)) fail(`Arquivo de evidência já existe: ${outputPath}`, 'local_proof_output_exists');

    const header = [
        'CLOVER_RESET_P0_DISPOSABLE_PROOF_V1',
        `STARTED_AT=${new Date().toISOString()}`,
        `GIT_HEAD=${git.head}`,
        `GIT_WORKTREE=${git.status}`,
        `NODE=${process.version}`,
        `CANONICAL_NODE=${canonicalNodeVersion}`,
        `PLATFORM=${process.platform}/${process.arch}`,
        `FREE_BYTES=${freeBytes ?? 'UNKNOWN'}`,
        'LIVE_DB_ALLOWED=NO',
        'REAL_RESET_ALLOWED=NO',
        'PRE_RESET_ACTIVATION_ALLOWED=NO',
        '',
    ].join('\n');
    fs.writeFileSync(outputPath, header, { flag: 'wx' });
    const write = (text) => fs.appendFileSync(outputPath, text);

    const childEnv = safeChildEnv();
    const run = await runAndTee(
        process.execPath,
        [path.join(ROOT, 'scripts', 'checkResetGoNoGo.js'), '--report-only'],
        { cwd: ROOT, env: childEnv, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
        write
    );
    write(`\nCHILD_EXIT=${run.code}\nCHILD_SIGNAL=${run.signal || 'NONE'}\n`);
    if (run.code !== 0 || run.signal) {
        fail(`Agregador terminou de forma anormal: exit=${run.code}, signal=${run.signal || 'none'}`, 'local_proof_child_failed');
    }

    const summary = extractSummary(run.combined);
    assertTechnicalProofSummary(summary);
    write('LOCAL_P0_DISPOSABLE_PROOF=PASS\n');
    write(`COMPLETED_AT=${new Date().toISOString()}\n`);
    console.log('\nLOCAL_P0_DISPOSABLE_PROOF=PASS');
    console.log(`EVIDENCE_FILE=${outputPath}`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error('LOCAL_P0_DISPOSABLE_PROOF=FAIL');
        console.error(`BLOCKER=${error.code || 'local_proof_exception'}:${error.message}`);
        process.exitCode = 2;
    });
}

module.exports = {
    DANGEROUS_ENV_KEYS,
    MIN_FREE_BYTES,
    assertCanonicalNodeVersion,
    assertSafeEnvironment,
    assertTechnicalProofSummary,
    extractSummary,
    loadCanonicalNodeVersion,
    parseArgs,
    safeChildEnv,
};
