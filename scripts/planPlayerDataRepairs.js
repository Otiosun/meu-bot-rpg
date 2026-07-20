'use strict';

const fs = require('fs');
const path = require('path');
const {
    buildRepairPlan,
    loadReport,
    renderMarkdown,
} = require('../helpers/clover/playerDataRepairPlanner');

function parseArgs(argv) {
    const options = {};
    for (const arg of argv) {
        if (arg.startsWith('--report=')) options.report = arg.slice('--report='.length);
        if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length);
    }
    return options;
}

function latestAudit(backupsDir) {
    const candidates = fs.readdirSync(backupsDir)
        .filter((name) => /^player-data-integrity-audit-.*\.json$/i.test(name))
        .map((name) => ({
            name,
            path: path.join(backupsDir, name),
            mtime: fs.statSync(path.join(backupsDir, name)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);
    if (!candidates.length) throw new Error('Nenhum relatório de auditoria encontrado em backups/.');
    return candidates[0].path;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const root = path.resolve(__dirname, '..');
    const backupsDir = path.join(root, 'backups');
    const reportPath = options.report
        ? path.resolve(options.report)
        : latestAudit(backupsDir);
    const report = loadReport(reportPath);
    const plan = buildRepairPlan(report);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseOutput = options.output
        ? path.resolve(options.output)
        : path.join(backupsDir, `player-data-repair-plan-${stamp}`);
    const jsonPath = baseOutput.endsWith('.json') ? baseOutput : `${baseOutput}.json`;
    const mdPath = jsonPath.replace(/\.json$/i, '.md');

    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    fs.writeFileSync(mdPath, renderMarkdown(plan), 'utf8');

    console.log('\n=== PLANO DE REPARO DOS DADOS ===');
    console.log('Modo: SOMENTE LEITURA');
    console.log(`Relatório: ${reportPath}`);
    console.log(`Apontamentos originais: ${plan.summary.originalIssues}`);
    console.log(`Revisões opcionais excluídas: ${plan.summary.optionalReviewsExcluded}`);
    console.log(`Apontamentos acionáveis: ${plan.summary.actionableIssues}`);
    console.log(`Jogadores acionáveis: ${plan.summary.actionablePlayers}`);
    console.log(`Correções automáticas autorizadas: ${plan.summary.automaticRepairs}`);
    console.log('\nPlano JSON:');
    console.log(jsonPath);
    console.log('\nPlano legível:');
    console.log(mdPath);
    console.log('\nNenhum dado foi alterado.');
}

try {
    main();
} catch (error) {
    console.error(`Falha ao gerar plano: ${error.message}`);
    process.exitCode = 1;
}
