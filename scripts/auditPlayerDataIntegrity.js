'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { auditPlayerDataIntegrity } = require('../helpers/clover/playerDataIntegrityAudit');

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

function outputPath(input) {
    if (input) return path.resolve(input);
    return path.resolve('backups', `player-data-integrity-audit-${timestampKey()}.json`);
}

function compactIssue(item) {
    const subject = item.characterName || item.entity || 'Registro global';
    return `[${item.severity.toUpperCase()}] ${subject} · ${item.category}/${item.code}`;
}

async function main() {
    const databasePath = path.resolve(argument('db') || './banco.sqlite');
    const reportPath = outputPath(argument('output'));
    const includeArchived = hasFlag('include-archived');

    if (!fs.existsSync(databasePath)) {
        throw new Error(`Banco não encontrado: ${databasePath}`);
    }

    const db = await open({
        filename: databasePath,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });

    let report;
    try {
        await db.exec('PRAGMA query_only = ON');
        report = await auditPlayerDataIntegrity(db, {
            includeArchived,
            databaseLabel: databasePath,
        });
    } finally {
        await db.close();
    }

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log('\n=== AUDITORIA DE INTEGRIDADE DOS JOGADORES ===');
    console.log('Modo: SOMENTE LEITURA');
    console.log(`Banco: ${databasePath}`);
    console.log(`Jogadores analisados: ${report.summary.playersScanned}`);
    console.log(`Jogadores com apontamentos: ${report.summary.playersWithIssues}`);
    console.log(`Total de apontamentos: ${report.summary.issueCount}`);
    console.log(`Críticos: ${report.summary.bySeverity.critical || 0}`);
    console.log(`Avisos: ${report.summary.bySeverity.warning || 0}`);
    console.log(`Revisões humanas: ${report.summary.bySeverity.review || 0}`);

    const important = report.issues.filter((item) => item.severity !== 'review').slice(0, 30);
    if (important.length) {
        console.log('\nPrimeiros apontamentos objetivos:');
        for (const item of important) console.log(`- ${compactIssue(item)}`);
        if (report.issues.filter((item) => item.severity !== 'review').length > important.length) {
            console.log('- ... consulte o relatório completo para os demais.');
        }
    }

    console.log(`\nRelatório salvo em:\n${reportPath}`);
    console.log('\nNenhum dado foi alterado.');
}

main().catch((error) => {
    console.error('\nFalha na auditoria:', error?.stack || error?.message || error);
    process.exitCode = 1;
});
