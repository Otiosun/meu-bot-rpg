'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const TEST_FILES = [
    'tests/dreamWorldsV1.test.js',
    'tests/dreamWorldsHttp.test.js',
    'tests/dreamWorldsOperations.test.js',
    'tests/dreamWorldsSlotPolicy.test.js',
    'tests/dreamWorldsAudit.test.js',
    'tests/dreamWorldsServerRegistration.test.js',
    'tests/dreamWorldsConcurrency.test.js',
    'tests/dreamWorldsCancellationPolicy.test.js',
    'tests/dreamWorldsPreviewApi.test.js',
];

function argument(name) {
    const prefix = `--${name}=`;
    const item = process.argv.slice(2).find((value) => value.startsWith(prefix));
    return item ? item.slice(prefix.length) : null;
}

function hasFlag(name) {
    return process.argv.slice(2).includes(`--${name}`);
}

function timestampKey(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, '-');
}

function run(command, args, label) {
    console.log(`\n=== ${label} ===`);
    const result = spawnSync(command, args, {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'inherit',
        env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const error = new Error(`${label} falhou com código ${result.status}.`);
        error.exitCode = Number(result.status || 1);
        throw error;
    }
}

function sqlString(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
}

async function createConsistentBackup(sourcePath, destinationPath) {
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    if (fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath);

    const db = await open({
        filename: sourcePath,
        driver: sqlite3.Database,
    });
    try {
        await db.exec(`VACUUM INTO ${sqlString(destinationPath)}`);
    } finally {
        await db.close();
    }
}

async function main() {
    const root = path.resolve(__dirname, '..');
    const databaseInput = argument('db');
    const skipTests = hasFlag('skip-tests');
    const skipAudit = hasFlag('skip-audit');
    const seedPreview = hasFlag('seed-preview');
    const stamp = timestampKey();

    console.log('\n=== VALIDAÇÃO MUNDOS DOS SONHOS V1 ===');
    console.log(`Projeto: ${root}`);
    console.log('O banco original é usado apenas como origem da cópia SQLite.');

    if (!skipTests) {
        run(process.execPath, ['--test', ...TEST_FILES], 'SUÍTE ESPECÍFICA');
    }

    if (skipAudit && !seedPreview) {
        console.log('\nAuditoria ignorada por --skip-audit.');
        return;
    }

    if (!databaseInput) {
        console.log('\nTestes concluídos. Cópia e auditoria não executadas porque --db não foi informado.');
        console.log('Exemplo: node scripts/validateDreamWorldsV1.js --db=./banco.sqlite');
        console.log('Com conteúdo demonstrativo na cópia: adicione --seed-preview.');
        return;
    }

    const sourcePath = path.resolve(databaseInput);
    if (!fs.existsSync(sourcePath)) {
        throw new Error(`Banco não encontrado: ${sourcePath}`);
    }

    const backupPath = path.resolve(root, 'backups', `dream-worlds-validation-${stamp}.sqlite`);
    const reportPath = path.resolve(root, 'backups', `dream-worlds-validation-${stamp}.json`);

    console.log('\n=== CÓPIA CONSISTENTE ===');
    console.log(`Origem preservada: ${sourcePath}`);
    console.log(`Cópia de validação: ${backupPath}`);
    await createConsistentBackup(sourcePath, backupPath);

    if (seedPreview) {
        run(
            process.execPath,
            [
                'scripts/seedDreamWorldsPreview.js',
                `--db=${backupPath}`,
                '--allow-preview-write',
            ],
            'CONTEÚDO DEMONSTRATIVO NA CÓPIA'
        );
    }

    if (!skipAudit) {
        run(
            process.execPath,
            [
                'scripts/auditDreamWorldsV1.js',
                `--db=${backupPath}`,
                `--output=${reportPath}`,
            ],
            'AUDITORIA DA CÓPIA'
        );
    }

    console.log('\n=== GATE CONCLUÍDO ===');
    console.log(`Cópia preservada: ${backupPath}`);
    if (!skipAudit) console.log(`Relatório: ${reportPath}`);
    if (seedPreview) console.log('A cópia contém conteúdo demonstrativo não canônico para o preview do frontend.');
    console.log('Nenhuma tabela ou registro foi alterado no banco original.');
}

main().catch((error) => {
    console.error('\nValidação interrompida:', error?.stack || error?.message || error);
    process.exitCode = Number(error?.exitCode || 1);
});
