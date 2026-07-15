'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const TREE_DIR = path.join(ROOT_DIR, 'data', 'clover', 'trees');
const ARTIFACT_DIR = path.join(ROOT_DIR, 'artifacts', 'capacity-catalog');
const TREE_IDS = ['mana', 'criacao', 'reforco', 'fisico', 'suporte'];

const COVERAGE = {
    criacao: [
        /^criacao$/, /^controle$/, /^estrutura$/, /^juncao_de_forma$/,
        /^forca_magica_(i|ii|iii)$/, /^velocidade_magica_(i|ii|iii)$/,
        /^defesa_magica_(i|ii|iii)$/, /^densidade_(i|ii|iii)$/,
        /^precisao_(i|ii|iii)$/, /^armas_(i|ii|iii)$/,
        /^formas_humanoides_(i|ii|iii)$/, /^ambiente_(i|ii|iii)$/,
    ],
    reforco: [
        /^reforco$/, /^intensidade_(i|ii|iii)$/, /^estabilidade_(i|ii|iii)$/,
        /^foco_de_atributo$/, /^duplo_foco$/, /^multiplo_foco$/,
        /^forca_reforcada$/, /^velocidade_reforcada$/, /^agilidade_reforcada$/,
        /^resistencia_reforcada$/, /^defesa_reforcada$/, /^invencivel$/, /^invicto$/,
        /^reforco_por_toque$/, /^reforco_a_distancia$/, /^reforco_coletivo$/,
        /^juncao_de_forma$/, /^reforco_avancado$/, /^reforco_avancado_armas$/,
        /^reforco_avancado_formas_humanoides$/, /^reforco_avancado_ambiente$/,
    ],
    mana: [
        /^mana$/, /^percepcao_de_mana$/, /^sentir_mana_(i|ii|iii)$/,
        /^leitura_de_flutuacao$/, /^assinatura_magica$/, /^fluxo_de_mana(_i)?$/,
        /^circulacao$/, /^estabilidade$/, /^canalizacao$/, /^ritmo_de_mana$/,
        /^emissao_de_mana_i$/, /^retencao_de_mana_i$/, /^mana_bullet_(i|ii|iii)$/,
        /^pulso_de_mana_(i|ii|iii)$/, /^mana_skin_(i|ii|iii)$/, /^manto_de_mana_i$/,
        /^campo_de_mana_(i|ii|iii)$/, /^economia_de_mana_(i|ii|iii)$/,
        /^recuperacao_(i|ii|iii)$/, /^ocultacao_de_mana$/, /^nucleo_de_mana$/,
        /^leitura_ambiental$/, /^adaptacao_ambiental$/, /^ambiente_de_mana_(i|ii|iii)$/,
        /^ressonancia$/, /^metodo_de_mana$/, /^mana_zone_(i|ii|iii)$/,
        /^dominio_de_mana$/, /^controle_fino_(i|ii|iii)$/, /^compressao_de_mana$/,
        /^voo_de_vassoura$/, /^revestimento_de_objeto$/, /^manutencao_simultanea$/,
        /^pressao_de_mana$/, /^condutor$/, /^reservatorio$/, /^dominador$/,
    ],
    fisico: [
        /^fisico$/, /^vigor$/, /^controle_corporal$/, /^percepcao_fisica$/,
        /^forca_aplicada_(i|ii|iii|iv)$/, /^resistencia_corporal_(i|ii|iii|iv)$/,
        /^condicionamento_fisico_(i|ii|iii|iv)$/, /^mobilidade_(i|ii|iii|iv)$/,
        /^reflexos_corporais_(i|ii|iii|iv)$/, /^precisao_tecnica_(i|ii|iii|iv)$/,
        /^visao_(i|ii|iii|iv|v)$/, /^audicao_(i|ii|iii|iv|v)$/,
        /^olfato_(i|ii|iii|iv|v)$/, /^tato_(i|ii|iii|iv|v)$/,
        /^paladar_(i|ii|iii|iv|v)$/, /^intuicao_corporal_(i|ii|iii|iv|v)$/,
        /^barbaro_(i|ii)$/, /^tirano_(i|ii)$/, /^benevolente_(i|ii)$/,
        /^culto_(i|ii)$/, /^justo_(i|ii)$/, /^injusto_(i|ii)$/,
        /^instinto_(i|ii)$/, /^contra_magos$/, /^ki$/, /^zetten$/, /^apice_fisico$/,
    ],
    suporte: [/.*/],
};

function ensureArtifactDir() {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

function loadTree(treeId) {
    return JSON.parse(fs.readFileSync(path.join(TREE_DIR, `${treeId}.json`), 'utf8'));
}

function isCovered(treeId, nodeId) {
    return (COVERAGE[treeId] || []).some((pattern) => pattern.test(nodeId));
}

function serializeNode(node) {
    return {
        id: node.id,
        name: node.name,
        route: node.route || null,
        tier: Number(node.tier || 0),
        requiresApproval: node.requiresApproval === true,
        risk: node.metadata?.risk || null,
        technicalWeight: node.metadata?.technicalWeight ?? null,
    };
}

function writeReport(report) {
    ensureArtifactDir();
    fs.writeFileSync(
        path.join(ARTIFACT_DIR, 'coverage-report.json'),
        `${JSON.stringify(report, null, 2)}\n`,
        'utf8'
    );

    const text = [
        'RELATÓRIO DE COBERTURA DO CATÁLOGO',
        '',
        `Total de nós: ${report.totals.nodes}`,
        `Cobertos: ${report.totals.covered}`,
        `Sem cobertura específica: ${report.totals.missing}`,
        '',
        ...report.trees.flatMap((tree) => [
            `${tree.name} (${tree.treeId})`,
            `- Nós: ${tree.total}`,
            `- Cobertos: ${tree.covered}`,
            `- Sem cobertura: ${tree.missing.length}`,
            ...(tree.missing.length
                ? ['', ...tree.missing.map((node) => `- ${node.id} — ${node.name}`)]
                : []),
            '',
        ]),
    ].join('\n');

    fs.writeFileSync(path.join(ARTIFACT_DIR, 'coverage-report.txt'), `${text}\n`, 'utf8');
}

function main() {
    const report = {
        generatedAt: new Date().toISOString(),
        totals: { nodes: 0, covered: 0, missing: 0 },
        trees: [],
    };

    for (const treeId of TREE_IDS) {
        const tree = loadTree(treeId);
        const nodes = tree.nodes || [];
        const missingNodes = nodes.filter((node) => !isCovered(treeId, node.id));
        const coveredCount = nodes.length - missingNodes.length;

        report.trees.push({
            treeId,
            name: tree.name || treeId,
            total: nodes.length,
            covered: coveredCount,
            missing: missingNodes.map(serializeNode),
            genericFallback: treeId === 'suporte',
        });
        report.totals.nodes += nodes.length;
        report.totals.covered += coveredCount;
        report.totals.missing += missingNodes.length;

        console.log(`\n${tree.name || treeId}`);
        console.log(`- Nós: ${nodes.length}`);
        console.log(`- Cobertos pelo catálogo: ${coveredCount}`);
        console.log(`- Sem cobertura específica: ${missingNodes.length}`);
        if (missingNodes.length) {
            console.log('');
            console.log(missingNodes.map((node) => `- ${node.id} — ${node.name}`).join('\n'));
        }
    }

    writeReport(report);

    if (report.totals.missing > 0) {
        console.log('\nResultado: existem nós sem cobertura específica no catálogo.');
        process.exitCode = 1;
        return;
    }

    console.log('\nResultado: catálogo cobre todos os nós auditados.');
}

main();
