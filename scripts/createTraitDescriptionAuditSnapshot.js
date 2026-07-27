'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
    backupSqliteDatabase,
} = require('../helpers/clover/sqliteBackupService');

function argumentValue(name) {
    const prefix = `--${name}=`;
    const argument = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
    return argument ? argument.slice(prefix.length) : null;
}

async function main() {
    const sourcePath = path.resolve(
        argumentValue('db') || process.env.CLOVER_DB_PATH || 'banco.sqlite'
    );
    const snapshotPath = path.resolve(
        argumentValue('output')
        || path.join(
            'artifacts',
            'trait-description-canonical',
            'trait-description-audit-snapshot.sqlite'
        )
    );
    const metadataPath = path.resolve(
        argumentValue('metadata')
        || `${snapshotPath}.json`
    );

    if (!fs.existsSync(sourcePath)) {
        throw new Error(`Banco de origem não encontrado: ${sourcePath}`);
    }
    if (sourcePath === snapshotPath) {
        throw new Error('O snapshot não pode substituir o banco de origem.');
    }

    const backup = await backupSqliteDatabase(sourcePath, snapshotPath);
    const metadata = {
        generatedAt: new Date().toISOString(),
        readOnlyAuditSnapshot: true,
        sourceFile: path.basename(backup.sourcePath),
        snapshotFile: path.basename(backup.destinationPath),
        snapshotPath: backup.destinationPath,
        bytes: backup.bytes,
        integrity: backup.integrity,
        method: backup.method,
    };

    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

    console.log('Snapshot SQLite consistente criado para auditoria de Traços.');
    console.log(`Origem: ${backup.sourcePath}`);
    console.log(`Snapshot: ${backup.destinationPath}`);
    console.log(`Integridade: ${backup.integrity}`);
    console.log(`Método: ${backup.method}`);
    console.log(`Bytes: ${backup.bytes}`);
    console.log(`Metadados: ${metadataPath}`);
}

main().catch((error) => {
    console.error('Falha ao criar snapshot de auditoria de Traços:', error);
    process.exitCode = 1;
});
