'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { auditDreamWorldsV1 } = require('../helpers/clover/dreamWorldsAuditService');

function argument(name) {
    const prefix = `--${name}=`;
    const item = process.argv.slice(2).find((value) => value.startsWith(prefix));
    return item ? item.slice(prefix.length) : null;
}

function timestampKey(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, '-');
}

async function main() {
    const databasePath = path.resolve(argument('db') || './banco.sqlite');
    const reportPath = path.resolve(
        argument('output') || path.join('backups', `dream-worlds-audit-${timestampKey()}.json`)
    );
    if (!fs.existsSync(databasePath)) throw new Error(`Banco não encontrado: ${databasePath}`);

    const db = await open({
        filename: databasePath,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });
    let report;
    try {
        await db.exec('PRAGMA query_only = ON');
        report = await auditDreamWorldsV1(db, { databaseLabel: databasePath });
    } finally {
        await db.close();
    }

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log('\n=== AUDITORIA — MUNDOS DOS SONHOS V1 ===');
    console.log('Modo: SOMENTE LEITURA');
    console.log(`Banco: ${databasePath}`);
    console.log(`Módulo instalado: ${report.installed ? 'sim' : 'não'}`);
    console.log(`Saudável: ${report.summary.healthy ? 'sim' : 'não'}`);
    console.log(`Apontamentos: ${report.summary.issueCount}`);
    console.log(`Críticos: ${report.summary.bySeverity.critical || 0}`);
    console.log(`Avisos: ${report.summary.bySeverity.warning || 0}`);

    if (report.installed) {
        console.log('\nRegistros:');
        for (const [key, value] of Object.entries(report.counts)) console.log(`- ${key}: ${value}`);
    }

    if (report.issues.length) {
        console.log('\nPrimeiros apontamentos:');
        for (const item of report.issues.slice(0, 30)) {
            console.log(`- [${item.severity.toUpperCase()}] ${item.code}: ${item.message}`);
        }
        if (report.issues.length > 30) console.log('- ... consulte o relatório completo.');
    }

    console.log(`\nRelatório salvo em:\n${reportPath}`);
    console.log('\nNenhum dado foi alterado.');
    if (!report.summary.healthy) process.exitCode = 2;
}

main().catch((error) => {
    console.error('\nFalha na auditoria:', error?.stack || error?.message || error);
    process.exitCode = 1;
});