'use strict';

const fs = require('fs');
const path = require('path');
const { buildTraitDescriptionRepairPlan } = require('../helpers/clover/traitDescriptionRepairPlanner');

function argumentValue(name) {
    const prefix = `--${name}=`;
    const argument = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
    return argument ? argument.slice(prefix.length) : null;
}

function main() {
    const inputPath = path.resolve(
        argumentValue('input')
        || path.join('artifacts', 'trait-description-audit', 'trait-description-candidates.json')
    );
    const outputPath = path.resolve(
        argumentValue('output')
        || path.join('artifacts', 'trait-description-audit', 'trait-description-repair-plan.json')
    );

    if (!fs.existsSync(inputPath)) {
        throw new Error(`Relatório de auditoria não encontrado: ${inputPath}`);
    }

    const report = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const plan = buildTraitDescriptionRepairPlan(report);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');

    console.log('Plano de reparo gerado sem alterar o banco.');
    console.log(`Modelos revisados: ${plan.summary.templatesReviewed}`);
    console.log(`Prontos para aprovação manual: ${plan.summary.readyForManualApproval}`);
    console.log(`Exigem análise manual: ${plan.summary.manualReview}`);
    console.log(`Ignorados: ${plan.summary.skipped}`);
    console.log(`Plano: ${outputPath}`);
}

try {
    main();
} catch (error) {
    console.error('Falha ao planejar reparos de descrição:', error);
    process.exitCode = 1;
}
