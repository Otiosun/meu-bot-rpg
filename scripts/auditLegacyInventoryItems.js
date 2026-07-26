'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { auditLegacyInventoryItems } = require('../helpers/clover/legacyInventoryAuditService');

function argumentValue(name) {
    const prefix = `--${name}=`;
    const argument = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
    return argument ? argument.slice(prefix.length) : null;
}

async function main() {
    const databasePath = path.resolve(argumentValue('db') || process.env.CLOVER_DB_PATH || 'banco.sqlite');
    const outputPath = path.resolve(
        argumentValue('output')
        || path.join('artifacts', 'legacy-inventory-audit', 'legacy-inventory-audit.json')
    );

    if (!fs.existsSync(databasePath)) throw new Error(`Banco não encontrado: ${databasePath}`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const db = await open({
        filename: databasePath,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });

    try {
        await db.exec('PRAGMA query_only = ON');
        const integrity = await db.get('PRAGMA integrity_check');
        const report = await auditLegacyInventoryItems(db);
        report.database = {
            file: path.basename(databasePath),
            integrity: integrity?.integrity_check || null,
        };
        fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

        console.log('Auditoria de itens legados concluída em modo somente leitura.');
        console.log(`Integridade: ${report.database.integrity || 'não informada'}`);
        console.log(`Itens legados: ${report.summary.legacyInventoryItems}`);
        console.log(`Grupos repetidos: ${report.summary.repeatedGroups}`);
        console.log(`Pares fragmentados: ${report.summary.fragmentPairs}`);
        console.log(`Relatório: ${outputPath}`);
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error('Falha na auditoria de itens legados:', error);
    process.exitCode = 1;
});
