'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
    backupSqliteDatabase,
} = require('../helpers/clover/sqliteBackupService');

function timestampKey(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, '-');
}

function parseArgs(argv) {
    const options = {
        db: './banco.sqlite',
        output: null,
        metadata: null,
        runtimeSha: process.env.CLOVER_RUNTIME_SHA || null,
        expectedAuditorSha: process.env.CLOVER_AUDITOR_SHA || null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--db') options.db = argv[++index];
        else if (arg.startsWith('--db=')) options.db = arg.slice('--db='.length);
        else if (arg === '--output') options.output = argv[++index];
        else if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length);
        else if (arg === '--metadata') options.metadata = argv[++index];
        else if (arg.startsWith('--metadata=')) options.metadata = arg.slice('--metadata='.length);
        else if (arg === '--runtime-sha') options.runtimeSha = argv[++index];
        else if (arg.startsWith('--runtime-sha=')) options.runtimeSha = arg.slice('--runtime-sha='.length);
        else if (arg === '--expected-auditor-sha') options.expectedAuditorSha = argv[++index];
        else if (arg.startsWith('--expected-auditor-sha=')) {
            options.expectedAuditorSha = arg.slice('--expected-auditor-sha='.length);
        } else if (arg === '--expected-sha') {
            options.expectedAuditorSha = argv[++index];
        } else if (arg.startsWith('--expected-sha=')) {
            options.expectedAuditorSha = arg.slice('--expected-sha='.length);
        } else throw new Error(`Argumento desconhecido: ${arg}`);
    }

    if (!options.output) {
        options.output = path.join('backups', `clover-phase0-snapshot-${timestampKey()}.sqlite`);
    }
    if (!options.metadata) options.metadata = `${options.output}.metadata.json`;
    return options;
}

function git(args) {
    try {
        return execFileSync('git', args, {
            cwd: path.resolve(__dirname, '..'),
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

function sha256File(filename) {
    const hash = crypto.createHash('sha256');
    const file = fs.readFileSync(filename);
    hash.update(file);
    return hash.digest('hex');
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const sourcePath = path.resolve(options.db);
    const destinationPath = path.resolve(options.output);
    const metadataPath = path.resolve(options.metadata);

    if (!fs.existsSync(sourcePath)) throw new Error(`Banco não encontrado: ${sourcePath}`);
    if (fs.existsSync(destinationPath)) throw new Error(`Snapshot já existe: ${destinationPath}`);
    if (fs.existsSync(metadataPath)) throw new Error(`Metadados já existem: ${metadataPath}`);

    const auditorHead = git(['rev-parse', 'HEAD']);
    const auditorOriginMain = git(['rev-parse', 'origin/main']);
    const auditorBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const dirtySummary = git(['status', '--short']);
    const runtimeSha = String(options.runtimeSha || '').trim() || null;
    const expectedAuditorSha = String(options.expectedAuditorSha || '').trim() || null;
    const auditorMatchesExpected = sameSha(auditorHead, expectedAuditorSha);

    if (auditorMatchesExpected === false) {
        throw new Error(
            `O auditor está em ${auditorHead || 'SHA indisponível'}, mas era esperado ${expectedAuditorSha}. `
            + 'O snapshot não foi iniciado.'
        );
    }

    const result = await backupSqliteDatabase(sourcePath, destinationPath);
    const metadata = {
        metadataVersion: 'clover-phase0-snapshot-v2',
        createdAt: new Date().toISOString(),
        runtimeObserved: {
            deployedSha: runtimeSha,
            shaProvided: Boolean(runtimeSha),
        },
        auditor: {
            head: auditorHead,
            originMain: auditorOriginMain,
            branch: auditorBranch,
            dirty: Boolean(dirtySummary),
            dirtySummary: dirtySummary ? dirtySummary.split(/\r?\n/).slice(0, 100) : [],
            expectedSha: expectedAuditorSha,
            expectedShaMatchesHead: auditorMatchesExpected,
        },
        source: {
            path: result.sourcePath,
            bytes: fs.statSync(result.sourcePath).size,
            modifiedAt: fs.statSync(result.sourcePath).mtime.toISOString(),
        },
        snapshot: {
            path: result.destinationPath,
            bytes: result.bytes,
            integrity: result.integrity,
            method: result.method,
            sha256: sha256File(result.destinationPath),
        },
        execution: {
            node: process.version,
            platform: process.platform,
            pid: process.pid,
        },
    };

    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

    console.log('\n=== CLOVER · SNAPSHOT DA FASE 0 ===');
    console.log(`Origem: ${result.sourcePath}`);
    console.log(`Snapshot: ${result.destinationPath}`);
    console.log(`Tamanho: ${result.bytes} bytes`);
    console.log(`Integridade: ${result.integrity}`);
    console.log(`Método: ${result.method}`);
    console.log(`SHA-256 do snapshot: ${metadata.snapshot.sha256}`);
    console.log(`SHA observado do runtime: ${runtimeSha || 'não informado'}`);
    console.log(`SHA do auditor: ${auditorHead || 'indisponível'}`);
    console.log(`Metadados: ${metadataPath}`);
    console.log('O banco de origem não foi modificado.');
}

main().catch((error) => {
    console.error('\nFalha ao criar snapshot da Fase 0:', error?.stack || error?.message || error);
    process.exitCode = 1;
});
