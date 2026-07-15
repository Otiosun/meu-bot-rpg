'use strict';

const fs = require('fs');
const path = require('path');

const TREE_DIR = path.join(__dirname, '..', 'data', 'clover', 'trees');
const TREE_IDS = ['mana', 'criacao', 'reforco', 'fisico', 'suporte'];

const COVERAGE = {
    criacao: [
        /^criacao$/,
        /^controle$/,
        /^estrutura$/,
        /^juncao_de_forma$/,
        /^forca_magica_(i|ii|iii)$/,
        /^velocidade_magica_(i|ii|iii)$/,
        /^defesa_magica_(i|ii|iii)$/,
        /^densidade_(i|ii|iii)$/,
        /^precisao_(i|ii|iii)$/,
        /^armas_(i|ii|iii)$/,
        /^formas_humanoides_(i|ii|iii)$/,
        /^ambiente_(i|ii|iii)$/,
    ],
    reforco: [
        /^reforco$/,
        /^intensidade_(i|ii|iii)$/,
        /^estabilidade_(i|ii|iii)$/,
        /^forca_reforcada$/,
        /^velocidade_reforcada$/,
        /^agilidade_reforcada$/,
        /^resistencia_reforcada$/,
        /^defesa_reforcada$/,
        /^duplo_foco$/,
        /^multiplo_foco$/,
        /^invencivel$/,
        /^invicto$/,
        /^reforco_por_toque$/,
        /^reforco_a_distancia$/,
        /^reforco_coletivo$/,
        /^juncao_de_forma$/,
        /^reforco_avancado$/,
        /^reforco_avancado_armas$/,
        /^reforco_avancado_formas_humanoides$/,
        /^reforco_avancado_ambiente$/,
    ],
    mana: [
        /^mana$/,
        /^percepcao_de_mana$/,
        /^sentir_mana_(i|ii|iii)$/,
        /^assinatura_magica$/,
        /^fluxo_de_mana(_i)?$/,
        /^circulacao$/,
        /^estabilidade$/,
        /^canalizacao$/,
        /^emissao_de_mana_i$/,
        /^retencao_de_mana_i$/,
        /^mana_bullet_(i|ii|iii)$/,
        /^pulso_de_mana_(i|ii|iii)$/,
        /^mana_skin_(i|ii|iii)$/,
        /^manto_de_mana_i$/,
        /^campo_de_mana_(i|ii|iii)$/,
        /^economia_de_mana_(i|ii|iii)$/,
        /^recuperacao_(i|ii|iii)$/,
        /^leitura_ambiental$/,
        /^adaptacao_ambiental$/,
        /^ambiente_de_mana_(i|ii|iii)$/,
        /^ressonancia$/,
        /^metodo_de_mana$/,
        /^mana_zone_(i|ii|iii)$/,
        /^dominio_de_mana$/,
        /^controle_fino_(i|ii|iii)$/,
        /^compressao_de_mana$/,
        /^revestimento_de_objeto$/,
        /^manutencao_simultanea$/,
        /^pressao_de_mana$/,
    ],
    fisico: [
        /^fisico$/,
        /^vigor$/,
        /^controle_corporal$/,
        /^percepcao_fisica$/,
        /^forca_aplicada_(i|ii|iii|iv)$/,
        /^resistencia_corporal_(i|ii|iii|iv)$/,
        /^condicionamento_fisico_(i|ii|iii|iv)$/,
        /^mobilidade_(i|ii|iii|iv)$/,
        /^reflexos_corporais_(i|ii|iii|iv)$/,
        /^precisao_tecnica_(i|ii|iii|iv)$/,
        /^visao_(i|ii|iii|iv|v)$/,
        /^audicao_(i|ii|iii|iv|v)$/,
        /^olfato_(i|ii|iii|iv|v)$/,
        /^tato_(i|ii|iii|iv|v)$/,
        /^paladar_(i|ii|iii|iv|v)$/,
        /^intuicao_corporal_(i|ii|iii|iv|v)$/,
        /^barbaro_(i|ii)$/,
        /^tirano_(i|ii)$/,
        /^benevolente_(i|ii)$/,
        /^culto_(i|ii)$/,
        /^justo_(i|ii)$/,
        /^injusto_(i|ii)$/,
        /^instinto_(i|ii)$/,
        /^contra_magos$/,
        /^ki$/,
        /^zetten$/,
        /^apice_fisico$/,
    ],
    suporte: [/.*/],
};

function loadTree(treeId) {
    const filePath = path.join(TREE_DIR, `${treeId}.json`);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isCovered(treeId, nodeId) {
    return (COVERAGE[treeId] || []).some((pattern) => pattern.test(nodeId));
}

function nodeLine(node) {
    const approval = node.requiresApproval ? ' | approval' : '';
    const risk = node.metadata?.risk ? ` | risco: ${node.metadata.risk}` : '';
    return `- ${node.id} — ${node.name}${approval}${risk}`;
}

function main() {
    let hasMissing = false;

    for (const treeId of TREE_IDS) {
        const tree = loadTree(treeId);
        const nodes = tree.nodes || [];
        const missing = nodes.filter((node) => !isCovered(treeId, node.id));

        console.log(`\n${tree.name || treeId}`);
        console.log(`- Nós: ${nodes.length}`);
        console.log(`- Cobertos pelo catálogo: ${nodes.length - missing.length}`);
        console.log(`- Sem cobertura específica: ${missing.length}`);

        if (treeId === 'suporte') {
            console.log('- Suporte usa fallback genérico por nó registrado e exige leitura manual para usos sensíveis.');
        }

        if (missing.length) {
            hasMissing = true;
            console.log('');
            console.log(missing.map(nodeLine).join('\n'));
        }
    }

    if (hasMissing) {
        console.log('\nResultado: existem nós sem cobertura específica no catálogo.');
        process.exitCode = 1;
        return;
    }

    console.log('\nResultado: catálogo cobre todos os nós auditados.');
}

main();
