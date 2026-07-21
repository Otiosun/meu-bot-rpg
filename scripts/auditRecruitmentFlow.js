'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { auditRecruitmentFlow } = require('../helpers/clover/recruitmentFlowAuditV2');

function argument(name) {
    const prefix = `--${name}=`;
    const item = process.argv.slice(2).find((value) => value.startsWith(prefix));
    return item ? item.slice(prefix.length) : null;
}

function timestampKey(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, '-');
}

function outputPath(input) {
    if (input) return path.resolve(input);
    return path.resolve('backups', `recruitment-flow-audit-${timestampKey()}.json`);
}

function printIssue(issue) {
    const subject = issue.characterName || issue.playerId || (issue.referralId ? `indicação ${issue.referralId}` : 'sistema');
    return `[${issue.severity.toUpperCase()}] ${subject} · ${issue.code}: ${issue.message}`;
}

async function main() {
    const databasePath = path.resolve(argument('db') || './banco.sqlite');
    const reportPath = outputPath(argument('output'));

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
        report = await auditRecruitmentFlow(db, { databaseLabel: databasePath });
    } finally {
        await db.close();
    }

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log('\n=== AUDITORIA DO EVENTO DE RECRUTAMENTO ===');
    console.log('Modo: SOMENTE LEITURA');
    console.log(`Banco: ${databasePath}`);
    console.log(`Evento: ${report.event?.name || 'não encontrado'} · ${report.event?.status || '-'}`);
    console.log(`Loja ativa: ${report.event?.shopEnabled ? 'sim' : 'não'}`);
    console.log(`Players: ${report.summary.players} · liberados=${report.summary.releasedPlayers} · bloqueados=${report.summary.blockedPlayers}`);
    console.log(`Indicações: ${report.summary.referrals} · ${JSON.stringify(report.summary.referralsByStatus)}`);
    console.log(`Lançamentos antigos por PR: ${report.summary.groupLedgerEntries}`);
    console.log(`Registros novos de grupos: ${report.summary.groupSubmissions}`);
    console.log(`Grupos: informados=${report.summary.groupsReported} · remunerados=${report.summary.groupsCredited} · excedentes=${report.summary.groupsExcess}`);
    console.log(`PR concedido por grupos registrados: ${report.summary.groupPrAwarded}`);
    console.log(`Apontamentos: ${report.summary.issues} · críticos=${report.summary.critical} · avisos=${report.summary.warning}`);

    if (report.issues.length) {
        console.log('\nApontamentos objetivos:');
        for (const issue of report.issues.slice(0, 40)) console.log(`- ${printIssue(issue)}`);
        if (report.issues.length > 40) console.log('- ... consulte o relatório completo.');
    }

    console.log('\nCapacidades atuais:');
    console.log(`- Player não liberado abre painel: ${report.capabilities.unreleasedPlayerCanOpenDashboard ? 'sim' : 'não'}`);
    console.log(`- Validação da indicação: ${report.capabilities.referralValidationTrigger}`);
    console.log(`- Entrega transacional/idempotente: ${report.capabilities.rewardDeliveryTransactional && report.capabilities.rewardDeliveryIdempotent ? 'sim' : 'não'}`);
    console.log(`- 0,4 PR suportado: ${report.capabilities.fractionalPrStoredNatively ? 'sim' : 'não'}`);
    console.log(`- Quantidade real de grupos preservada: ${report.capabilities.excessGroupCountPreserved ? 'sim' : 'não'}`);
    console.log(`\nRelatório salvo em:\n${reportPath}`);
    console.log('\nNenhum dado foi alterado.');
}

main().catch((error) => {
    console.error('\nFalha na auditoria de recrutamento:', error?.stack || error?.message || error);
    process.exitCode = 1;
});
