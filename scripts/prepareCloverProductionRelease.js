'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CONFIRMATION = 'EU_AUTORIZO_PREPARAR_PUBLICACAO_CLOVER';

function parseArgs(argv = process.argv.slice(2)) {
    const args = {};
    for (const arg of argv) {
        const match = /^--([^=]+)=(.*)$/.exec(arg);
        if (match) args[match[1]] = match[2];
    }
    return args;
}

function hashFile(filePath) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(1024 * 1024);
    try {
        let bytesRead = 0;
        do {
            bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
        } while (bytesRead > 0);
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd || process.cwd(),
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
    });
    return {
        ok: !result.error && result.status === 0,
        status: result.status,
        stdout: String(result.stdout || '').trim(),
        stderr: String(result.stderr || '').trim(),
        error: result.error?.message || null,
    };
}

function assertCleanGit(cwd) {
    const status = run('git', ['status', '--short'], { cwd });
    if (!status.ok) throw new Error(status.stderr || status.error || 'git status falhou');
    if (status.stdout) throw new Error(`Git status nao esta limpo em ${cwd}:\n${status.stdout}`);
}

function buildPlan(options) {
    const backendRepo = path.resolve(options.backendRepo || process.cwd());
    const frontendRepo = path.resolve(options.frontendRepo || path.join(backendRepo, '..', 'Clover-multicolor'));
    const dbPath = path.resolve(options.db || path.join(backendRepo, 'banco.sqlite'));
    const outputDir = path.resolve(options.outputDir || path.join(backendRepo, 'artifacts', 'production-release'));
    const backendHead = run('git', ['rev-parse', 'HEAD'], { cwd: backendRepo });
    const frontendHead = run('git', ['rev-parse', 'HEAD'], { cwd: frontendRepo });

    if (!backendHead.ok) throw new Error(`Nao consegui ler HEAD backend: ${backendHead.stderr || backendHead.error}`);
    if (!frontendHead.ok) throw new Error(`Nao consegui ler HEAD frontend: ${frontendHead.stderr || frontendHead.error}`);
    if (!fs.existsSync(dbPath)) throw new Error(`Banco nao encontrado: ${dbPath}`);

    return {
        generatedAt: new Date().toISOString(),
        confirmationRequired: CONFIRMATION,
        backend: { repo: backendRepo, head: backendHead.stdout },
        frontend: { repo: frontendRepo, head: frontendHead.stdout },
        database: {
            path: dbPath,
            size: fs.statSync(dbPath).size,
            sha256: hashFile(dbPath),
        },
        outputDir,
        nextSteps: [
            'backup/hash do banco vivo',
            'verificar fila depth=0 active=false',
            'merge backend apos aprovacao humana',
            'atualizar runtime e rodar migrations autorizadas',
            'integrity_check e health local/publico',
            'merge frontend apos backend saudavel',
            'deploy Vercel autorizado',
            'smoke final e rollback se necessario',
        ],
    };
}

function runCli() {
    const args = parseArgs();
    if (args.confirm !== CONFIRMATION) {
        console.error(`Confirmacao ausente. Reexecute com --confirm=${CONFIRMATION}`);
        process.exitCode = 1;
        return;
    }

    const plan = buildPlan(args);
    assertCleanGit(plan.backend.repo);
    assertCleanGit(plan.frontend.repo);
    fs.mkdirSync(plan.outputDir, { recursive: true });
    const reportPath = path.join(plan.outputDir, `release-plan-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(plan, null, 2));
    console.log(`[clover-release] Plano protegido gerado em ${reportPath}`);
    console.log('[clover-release] Nenhum merge, deploy, migration ou restart foi executado.');
}

if (require.main === module) {
    try {
        runCli();
    } catch (error) {
        console.error(`[clover-release] ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { CONFIRMATION, buildPlan, parseArgs };
