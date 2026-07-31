'use strict';

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
        expectedSha: process.env.CLOVER_DEPLOY_SHA || null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--db') options.db = argv[++index];
        else if (arg.startsWith('--db=')) options.db = arg.slice('--db='.length);
        else if (arg === '--output') options.output = argv[++index];
        else if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length);
        else if (arg === '--metadata') options.metadata = argv[++index];
        else if (arg.startsWith('--metadata=')) options.metadata = arg.slice('--metadata='.length);
        else if (arg === '--expected-sha') options.expectedSha = argv[++index];
        else if (arg.startsWith('--expected-sha=')) options.expectedSha = arg.slice('--expected-sha='.length);
        else throw new Error(`Argumento desconhecido: ${arg}`);
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

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const sourcePath = path.resolve(options.db);
    const destinationPath = path.resolve(options.output);
    const metadataPath = path.resolve(options.metadata);

    if (!fs.existsSync(sourcePath)) {
        throw new Error(`Banco não encontrado: ${sourcePath}`);
    }
    if (fs.existsSync(destinationPath)) {
        throw new Error(`Snapshot já existe: ${destinationPath}`);
    }
    if (fs.existsSync(metadataPath)) {
        throw new Error(`Metadados já existem: ${metadataPath}`);
    }

    const head = git(['rev-parse', 'HEAD']);
    const originMain = git(['rev-parse', 'origin/main']);
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const dirtySummary = git(['status', '--short']);
    const expectedSha = String(options.expectedSha || '').trim() || null;
    const matchesExpected = sameSha(head, expectedSha);

    if (matchesExpected === false) {
        throw new Error(
            `O HEAD ${head || 'indisponível'} não corresponde ao SHA esperado ${expectedSha}. `
            + 'O snapshot não foi iniciado.'
        );
    }

    const result = await backupSqliteDatabase(sourcePath, destinationPath);
    const metadata = {
        metadataVersion: 'clover-phase0-snapshot-v1',
        createdAt: new Date().toISOString(),
        repository: {
            head,
            originMain,
            branch,
            dirty: Boolean(dirtySummary),
            dirtySummary: dirtySummary ? dirtySummary.split(/\r?\n/).slice(0, 100) : [],
            expectedDeployedSha: expectedSha,
            expectedShaMatchesHead: matchesExpected,
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
        },
        runtime: {
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
    console.log(`HEAD: ${head || 'indisponível'}`);
    console.log(`Metadados: ${metadataPath}`);
    console.log('O banco de origem não foi modificado.');
}

main().catch((error) => {
    console.error('\nFalha ao criar snapshot da Fase 0:', error?.stack || error?.message || error);
    process.exitCode = 1;
});
