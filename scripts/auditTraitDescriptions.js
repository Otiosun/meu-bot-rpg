'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { auditTraitDescriptions } = require('../helpers/clover/traitDescriptionAuditService');

function argumentValue(name) {
    const prefix = `--${name}=`;
    const argument = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
    return argument ? argument.slice(prefix.length) : null;
}

async function main() {
    const databasePath = path.resolve(argumentValue('db') || process.env.CLOVER_DB_PATH || 'banco.sqlite');
    const outputPath = path.resolve(
        argumentValue('output')
        || path.join('artifacts', 'trait-description-audit', 'trait-description-candidates.json')
    );

    if (!fs.existsSync(databasePath)) {
        throw new Error(`Banco não encontrado: ${databasePath}`);
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const db = await open({
        filename: databasePath,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });

    try {
        await db.exec('PRAGMA query_only = ON');
        const integrity = await db.get('PRAGMA integrity_check');
        const report = await auditTraitDescriptions(db);
        report.database = {
            file: path.basename(databasePath),
            integrity: integrity?.integrity_check || null,
        };
        fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

        console.log('Auditoria de descrições concluída em modo somente leitura.');
        console.log(`Banco: ${databasePath}`);
        console.log(`Integridade: ${report.database.integrity || 'não informada'}`);
        console.log(`Modelos sem descrição: ${report.summary.templatesMissingDescription}`);
        console.log(`Com candidatos: ${report.summary.missingWithCandidates}`);
        console.log(`Com candidato de alta confiança: ${report.summary.missingWithHighConfidenceCandidate}`);
        console.log(`Sem candidato: ${report.summary.missingWithoutCandidate}`);
        console.log(`Relatório: ${outputPath}`);
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error('Falha na auditoria de descrições:', error);
    process.exitCode = 1;
});
