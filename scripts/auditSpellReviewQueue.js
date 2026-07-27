'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { auditSpellReviewQueue } = require('../helpers/clover/spellQueueAuditService');

function argumentValue(name) {
    const prefix = `--${name}=`;
    const argument = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
    return argument ? argument.slice(prefix.length) : null;
}

async function main() {
    const databasePath = path.resolve(argumentValue('db') || process.env.CLOVER_DB_PATH || 'banco.sqlite');
    const outputPath = path.resolve(
        argumentValue('output')
        || path.join('artifacts', 'spell-queue-audit', 'spell-queue-audit.json')
    );
    const now = argumentValue('now') || undefined;
    if (!fs.existsSync(databasePath)) throw new Error(`Banco não encontrado: ${databasePath}`);

    const db = await open({
        filename: databasePath,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });

    try {
        await db.exec('PRAGMA query_only = ON');
        const integrityRow = await db.get('PRAGMA integrity_check');
        const integrity = integrityRow?.integrity_check || Object.values(integrityRow || {})[0] || null;
        const report = await auditSpellReviewQueue(db, { now });
        report.database = {
            file: path.basename(databasePath),
            integrity,
        };

        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

        console.log('Auditoria da fila de feitiços concluída em modo somente leitura.');
        console.log(`Integridade: ${integrity || 'não informada'}`);
        console.log(`Entradas ativas: ${report.summary.activeRows || 0}`);
        console.log(`Jogadores ativos: ${report.summary.activePlayers || 0}`);
        console.log(`Chamados: ${report.summary.calledRows || 0}`);
        console.log(`Fila antiga crítica: ${report.summary.waitingCriticalRows || 0}`);
        console.log(`Chamados antigos críticos: ${report.summary.calledCriticalRows || 0}`);
        console.log(`Sem capacidade para aprovação: ${report.summary.capacityBlockedRows || 0}`);
        console.log(`Relatório: ${outputPath}`);
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error('Falha na auditoria da fila de feitiços:', error);
    process.exitCode = 1;
});
