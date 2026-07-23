'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runAdminTraitLegacyMigration } = require('../helpers/clover/adminTraitLegacyMigrationService');
const { ensureAdminTraitProfileSyncTrigger } = require('../helpers/clover/adminTraitProfileSyncTrigger');

function readArgs(argv) {
    const result = {};
    for (let index = 2; index < argv.length; index += 1) {
        const key = argv[index];
        if (!key.startsWith('--')) continue;
        const value = argv[index + 1];
        if (value && !value.startsWith('--')) {
            result[key.slice(2)] = value;
            index += 1;
        } else {
            result[key.slice(2)] = true;
        }
    }
    return result;
}

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function main() {
    const args = readArgs(process.argv);
    const source = path.resolve(String(args.source || ''));
    const destination = path.resolve(String(args.destination || ''));
    const reportPath = path.resolve(String(args.report || ''));
    if (!args.source || !args.destination || !args.report) {
        throw new Error('Uso: node scripts/migrateAdminTraitsV2.js --source banco.sqlite --destination copia.sqlite --report relatorio.json [--overwrite]');
    }
    if (!fs.existsSync(source)) throw new Error(`Banco de origem não encontrado: ${source}`);
    if (source === destination) throw new Error('A prévia nunca pode sobrescrever o banco de origem.');
    if (fs.existsSync(destination) && !args.overwrite) throw new Error(`Destino já existe: ${destination}`);

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.copyFileSync(source, destination);
    const sourceSha256 = await sha256File(source);
    const db = await open({ filename: destination, driver: sqlite3.Database });
    try {
        const report = await runAdminTraitLegacyMigration(db, { sourceSha256 });
        report.profileSync = await ensureAdminTraitProfileSyncTrigger(db);
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
});
