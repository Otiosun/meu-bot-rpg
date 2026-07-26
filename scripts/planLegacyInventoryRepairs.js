'use strict';

const fs = require('fs');
const path = require('path');
const { buildLegacyInventoryRepairPlan } = require('../helpers/clover/legacyInventoryRepairPlanner');

function argumentValue(name) {
    const prefix = `--${name}=`;
    const argument = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
    return argument ? argument.slice(prefix.length) : null;
}

function main() {
    const inputPath = path.resolve(
        argumentValue('input')
        || path.join('artifacts', 'legacy-inventory-audit', 'legacy-inventory-audit.json')
    );
    const outputPath = path.resolve(
        argumentValue('output')
        || path.join('artifacts', 'legacy-inventory-audit', 'legacy-inventory-repair-plan.json')
    );

    if (!fs.existsSync(inputPath)) throw new Error(`Relatório não encontrado: ${inputPath}`);
    const report = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const plan = buildLegacyInventoryRepairPlan(report);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

    console.log('Plano de itens legados gerado sem executar alterações.');
    console.log(`Prontos para aprovação manual: ${plan.summary.readyForManualApproval}`);
    console.log(`Revisão manual: ${plan.summary.manualReview}`);
    console.log(`Itens cobertos: ${plan.summary.coveredInventoryItems}`);
    console.log(`Plano: ${outputPath}`);
}

try {
    main();
} catch (error) {
    console.error('Falha no planejamento dos itens legados:', error);
    process.exitCode = 1;
}
