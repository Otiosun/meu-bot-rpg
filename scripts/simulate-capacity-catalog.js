'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    formatPlayerCapacity,
    formatTechnicalCapacity,
} = require('../helpers/clover/capacityCatalogPresentationFinal');

const ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts', 'capacity-catalog');
const PLAYER_SOFT_LIMIT = 20000;
const TECHNICAL_SOFT_LIMIT = 50000;
const HARD_LIMIT = 60000;
const TREE_IDS = ['mana', 'criacao', 'reforco', 'fisico', 'suporte'];
const TREES = Object.fromEntries(TREE_IDS.map((treeId) => [
    treeId,
    require(`../data/clover/trees/${treeId}.json`),
]));

function deepMerge(target, source) {
    if (!source || typeof source !== 'object') return target;
    const output = Array.isArray(target) ? [...target] : { ...target };
    for (const [key, value] of Object.entries(source)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            output[key] = deepMerge(output[key] || {}, value);
        } else {
            output[key] = value;
        }
    }
    return output;
}

function nodeMap(tree) {
    return Object.fromEntries((tree.nodes || []).map((node) => [node.id, node]));
}

function treeState(treeId, ownedIds = [], extraNodes = []) {
    const tree = TREES[treeId];
    const nodes = [...(tree.nodes || []), ...extraNodes];
    const nodesById = Object.fromEntries(nodes.map((node) => [node.id, node]));
    return {
        ownedIds,
        tree: {
            ...tree,
            nodes,
            nodesById,
        },
        nodeStates: [],
    };
}

function summary(treeId, ownedIds) {
    const byId = nodeMap(TREES[treeId]);
    return {
        count: ownedIds.length,
        names: ownedIds.map((id) => byId[id]?.name || id),
    };
}

function baseCapacity(overrides = {}) {
    const capacity = {
        ok: true,
        playerId: 'sim-player@s.whatsapp.net',
        displayName: 'Simulação Clover',
        stageName: '6º Estágio',
        manaTotal: 4000,
        poderMagico: 24,
        stats: { pb_total: 80 },
        ph: { phAvailable: 12, phAccumulated: 580 },
        hexagon: {
            percepcao: 1,
            retencao: 2,
            emissao: 1,
            controle: 2,
            pressao: 1,
            alcance: 2,
        },
        hexagonLine: 'PER 1 | RET 2 | EMI 1 | CON 2 | PRE 1 | ALC 2',
        limits: {
            percepcaoLabel: 'leitura simples de mana evidente',
            duracaoLabel: 'até 2 ciclos em usos simples',
            emissaoLabel: 'emissão curta e direta',
            controleLabel: 'controle básico com ajuste simples',
            pressaoBonus: '+0%',
            alcanceLabel: 'até 8m',
            areaLabel: 'até 5m',
        },
        trees: {
            mana: treeState('mana'),
            criacao: treeState('criacao'),
            reforco: treeState('reforco'),
            fisico: treeState('fisico'),
        },
        supportTree: treeState('suporte'),
        treeSummaries: {
            mana: summary('mana', []),
            criacao: summary('criacao', []),
            reforco: summary('reforco', []),
            fisico: summary('fisico', []),
            suporte: summary('suporte', []),
        },
        creation: { flags: {} },
        reinforcement: { flags: {} },
        mana: { flags: {} },
        physical: { flags: {}, levels: {} },
        support: { owned: [], ownedNames: [] },
        approvalNodes: [],
        highRiskNodes: [],
        nextNodes: { mana: [], criacao: [], reforco: [], fisico: [] },
    };
    return deepMerge(capacity, overrides);
}

function withOwned(capacity, treeId, ownedIds, extraNodes = []) {
    const next = deepMerge(capacity, {});
    const state = treeState(treeId, ownedIds, extraNodes);
    if (treeId === 'suporte') {
        next.supportTree = state;
        next.treeSummaries.suporte = summary('suporte', ownedIds);
        next.support = {
            owned: ownedIds.map((id) => state.tree.nodesById[id]).filter(Boolean),
            ownedNames: ownedIds.map((id) => state.tree.nodesById[id]?.name || id),
        };
    } else {
        next.trees[treeId] = state;
        next.treeSummaries[treeId] = {
            count: ownedIds.length,
            names: ownedIds.map((id) => state.tree.nodesById[id]?.name || id),
        };
    }
    return next;
}

function buildScenarios() {
    const creationIds = [
        'criacao', 'controle', 'estrutura', 'forca_magica_i', 'forca_magica_ii',
        'velocidade_magica_i', 'defesa_magica_i', 'densidade_i', 'densidade_ii', 'precisao_i',
    ];
    let creation = withOwned(baseCapacity(), 'criacao', creationIds);
    creation = deepMerge(creation, {
        creation: { flags: {
            base: true, control: true, structure: true,
            forceLevel: 2, speedLevel: 1, defenseLevel: 1,
            densityLevel: 2, precisionLevel: 1,
        } },
    });

    const missingManaIds = [
        'mana', 'percepcao_de_mana', 'sentir_mana_i', 'sentir_mana_ii',
        'leitura_de_flutuacao', 'fluxo_de_mana_i', 'circulacao', 'estabilidade',
        'ritmo_de_mana', 'controle_fino_i', 'controle_fino_ii', 'voo_de_vassoura',
        'retencao_de_mana_i', 'recuperacao_i', 'recuperacao_ii', 'recuperacao_iii',
        'ocultacao_de_mana', 'nucleo_de_mana', 'condutor', 'reservatorio', 'dominador',
    ];
    let missingMana = withOwned(baseCapacity(), 'mana', missingManaIds);
    missingMana = deepMerge(missingMana, {
        mana: { flags: {
            base: true, perception: true, sensing: true, sensingLevel: 2,
            flow: true, circulation: true, stability: true, retention: true,
            recoveryLevel: 3, fineControl: true, fineControlLevel: 2,
        } },
    });

    const reinforcementIds = [
        'reforco', 'intensidade_i', 'intensidade_ii', 'estabilidade_i',
        'foco_de_atributo', 'duplo_foco', 'invencivel', 'forca_reforcada',
    ];
    let reinforcement = withOwned(baseCapacity(), 'reforco', reinforcementIds);
    reinforcement = deepMerge(reinforcement, {
        reinforcement: { flags: {
            base: true, intensityLevel: 2, stabilityLevel: 1,
            focusCount: 2, attributes: ['Força'], selfBuff: true,
        } },
    });

    const manaAdvancedIds = [
        'mana', 'percepcao_de_mana', 'sentir_mana_i', 'sentir_mana_ii', 'sentir_mana_iii',
        'fluxo_de_mana_i', 'circulacao', 'estabilidade', 'canalizacao',
        'emissao_de_mana_i', 'mana_bullet_i', 'mana_bullet_ii', 'mana_bullet_iii',
        'mana_skin_i', 'mana_skin_ii', 'manto_de_mana_i', 'campo_de_mana_i',
        'campo_de_mana_ii', 'campo_de_mana_iii', 'controle_fino_i', 'controle_fino_ii',
        'controle_fino_iii', 'compressao_de_mana', 'manutencao_simultanea',
        'ambiente_de_mana_i', 'mana_zone_i', 'mana_zone_ii',
    ];
    let manaAdvanced = withOwned(baseCapacity(), 'mana', manaAdvancedIds);
    manaAdvanced = deepMerge(manaAdvanced, {
        mana: { flags: {
            base: true, perception: true, sensing: true, sensingLevel: 3,
            flow: true, circulation: true, stability: true, channeling: true,
            emission: true, retention: true, bulletLevel: 3,
            manaSkin: true, manaSkinLevel: 2, manaMantle: true,
            field: true, fieldLevel: 3, fineControl: true, fineControlLevel: 3,
            compression: true, simultaneousMaintenance: true,
            environment: true, environmentLevel: 1, zone: true, zoneLevel: 2,
        } },
    });

    const physicalIds = [
        'fisico', 'vigor', 'forca_aplicada_i', 'forca_aplicada_ii', 'forca_aplicada_iii',
        'forca_aplicada_iv', 'controle_corporal', 'mobilidade_i', 'mobilidade_ii',
        'reflexos_corporais_i', 'percepcao_fisica', 'visao_i', 'visao_ii', 'ki', 'zetten',
    ];
    let physical = withOwned(baseCapacity(), 'fisico', physicalIds);
    physical = deepMerge(physical, {
        physical: {
            flags: { base: true, vigor: true, control: true, perception: true, ki: true, zetten: true },
            levels: {
                strength: 4, resistance: 0, conditioning: 0,
                mobility: 2, reflexes: 1, precision: 0,
                senses: { visao: 2 }, identities: {},
            },
        },
    });

    const supportNodes = TREES.suporte.nodes || [];
    const supportIds = supportNodes.slice(0, Math.min(4, supportNodes.length)).map((node) => node.id);
    const support = withOwned(baseCapacity(), 'suporte', supportIds);

    const customNode = {
        id: 'no_futuro_de_teste',
        name: 'Nó Futuro de Teste',
        route: 'teste',
        tier: 99,
        shortEffect: 'Efeito novo ainda não catalogado, mas que precisa aparecer.',
        effect: 'Efeito novo ainda não catalogado, mas que precisa aparecer.',
        requiresApproval: true,
        metadata: { technicalWeight: 4, risk: 'alto' },
    };
    let fallback = withOwned(baseCapacity(), 'mana', ['mana', customNode.id], [customNode]);
    fallback = deepMerge(fallback, { mana: { flags: { base: true } } });

    return [
        { name: 'iniciante vazio', capacity: baseCapacity(), required: ['Sem avanço relevante em Mana comprado', 'Resumo Geral'] },
        { name: 'criação com buff II', capacity: creation, required: ['Força Mágica II', '+20%', 'Força Mágica III', 'não comprado'] },
        { name: 'nós de mana antes invisíveis', capacity: missingMana, required: ['Leitura de Flutuacao', 'Ritmo de Mana', 'Voo de Vassoura', 'Ocultacao de Mana', 'Nucleo de Mana', 'Condutor', 'Reservatorio', 'Dominador'] },
        { name: 'reforço com foco', capacity: reinforcement, required: ['Foco de Atributo', 'Duplo Foco', 'Intensidade II'] },
        { name: 'mana avançada', capacity: manaAdvanced, required: ['Bala de Mana III', 'Pele de Mana II: Peso 2', 'Zona de Mana II'] },
        { name: 'físico avançado', capacity: physical, required: ['Força Aplicada IV', '+40%', 'Ki', 'Zetten'] },
        { name: 'suporte real', capacity: support, required: supportIds.length ? [support.support.ownedNames[0], 'Leitura dos nós comprados'] : ['Suporte está parcialmente liberado'] },
        { name: 'fallback de nó futuro', capacity: fallback, required: ['Nó Futuro de Teste', 'Efeito novo ainda não catalogado', 'Peso técnico de Nó Futuro de Teste: +4'] },
    ];
}

function longestLine(output) {
    return String(output).split('\n').reduce((max, line) => Math.max(max, line.length), 0);
}

function validateOutput(label, output, required, softLimit) {
    assert.strictEqual(typeof output, 'string', `${label}: saída não é string`);
    assert(output.length > 200, `${label}: saída curta demais`);
    assert(output.length < softLimit, `${label}: saída grande demais (${output.length})`);
    assert(output.length < HARD_LIMIT, `${label}: ultrapassa limite técnico`);
    assert(longestLine(output) < 1000, `${label}: linha longa demais`);
    for (const forbidden of ['undefined', '[object Object]', 'NaN']) {
        assert(!output.includes(forbidden), `${label}: contém ${forbidden}`);
    }
    for (const token of required) {
        assert(output.includes(token), `${label}: não contém ${JSON.stringify(token)}`);
    }
}

function writeArtifacts(results) {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    const snapshots = results.flatMap((result) => [
        '='.repeat(80), result.name.toUpperCase(), '='.repeat(80), '',
        '.CAPACIDADE', '', result.player, '',
        '.CAPACIDADE TÉCNICA', '', result.technical, '',
    ]).join('\n');
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'capacity-output-snapshots.txt'), `${snapshots}\n`, 'utf8');

    const report = {
        generatedAt: new Date().toISOString(),
        summary: {
            total: results.length,
            passed: results.filter((result) => !result.errors.length).length,
            failed: results.filter((result) => result.errors.length).length,
        },
        scenarios: results.map((result) => ({
            name: result.name,
            passed: !result.errors.length,
            errors: result.errors,
            playerCharacters: result.player.length,
            technicalCharacters: result.technical.length,
            playerLines: result.player.split('\n').length,
            technicalLines: result.technical.split('\n').length,
        })),
    };
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'simulation-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function main() {
    const results = [];
    for (const scenario of buildScenarios()) {
        const errors = [];
        let player = '';
        let technical = '';
        try {
            player = formatPlayerCapacity(scenario.capacity);
            technical = formatTechnicalCapacity(scenario.capacity, { full: true, admin: true });
            validateOutput(`${scenario.name} / player`, player, ['CAPACIDADE ATUAL', 'PB básico', 'Resumo Geral'], PLAYER_SOFT_LIMIT);
            validateOutput(`${scenario.name} / técnico`, technical, ['CAPACIDADE TÉCNICA', 'PER 1', 'Resumo Técnico'], TECHNICAL_SOFT_LIMIT);
            validateOutput(`${scenario.name} / conteúdo`, `${player}\n${technical}`, scenario.required, HARD_LIMIT);
        } catch (error) {
            errors.push(error?.message || String(error));
        }
        results.push({ name: scenario.name, player, technical, errors });
        if (errors.length) {
            console.error(`✕ ${scenario.name}`);
            errors.forEach((error) => console.error(`  - ${error}`));
        } else {
            console.log(`✓ ${scenario.name}`);
        }
    }

    writeArtifacts(results);
    const failed = results.filter((result) => result.errors.length);
    if (failed.length) {
        console.error(`\nResultado: ${failed.length}/${results.length} simulações falharam.`);
        process.exitCode = 1;
        return;
    }
    console.log(`\nResultado: ${results.length} simulações passaram.`);
}

main();
