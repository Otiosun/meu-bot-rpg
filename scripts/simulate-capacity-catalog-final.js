'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    formatPlayerCapacity,
    formatTechnicalCapacity,
} = require('../helpers/clover/capacityCatalogPresentationFinal');

const ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts', 'capacity-catalog');
const TREE_IDS = ['mana', 'criacao', 'reforco', 'fisico', 'suporte'];
const TREES = Object.fromEntries(TREE_IDS.map((treeId) => [treeId, require(`../data/clover/trees/${treeId}.json`)]));
const PLAYER_LIMIT = 20000;
const TECHNICAL_LIMIT = 50000;
const HARD_LIMIT = 60000;

function deepMerge(target, source) {
    if (!source || typeof source !== 'object') return target;
    const output = Array.isArray(target) ? [...target] : { ...target };
    for (const [key, value] of Object.entries(source)) {
        output[key] = value && typeof value === 'object' && !Array.isArray(value)
            ? deepMerge(output[key] || {}, value)
            : value;
    }
    return output;
}

function treeState(treeId, ownedIds = [], extraNodes = []) {
    const tree = TREES[treeId];
    const nodes = [...(tree.nodes || []), ...extraNodes];
    return {
        ownedIds,
        tree: {
            ...tree,
            nodes,
            nodesById: Object.fromEntries(nodes.map((node) => [node.id, node])),
        },
        nodeStates: [],
    };
}

function namesFromState(state) {
    return state.ownedIds.map((id) => state.tree.nodesById[id]?.name || id);
}

function baseCapacity() {
    const trees = {
        mana: treeState('mana'),
        criacao: treeState('criacao'),
        reforco: treeState('reforco'),
        fisico: treeState('fisico'),
    };
    return {
        ok: true,
        playerId: 'sim-player@s.whatsapp.net',
        displayName: 'Simulação Clover',
        stageName: '6º Estágio',
        manaTotal: 4000,
        poderMagico: 24,
        stats: { pb_total: 80 },
        ph: { phAvailable: 12, phAccumulated: 580 },
        hexagon: { percepcao: 1, retencao: 2, emissao: 1, controle: 2, pressao: 1, alcance: 2 },
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
        trees,
        supportTree: treeState('suporte'),
        treeSummaries: {
            mana: { count: 0, names: [] },
            criacao: { count: 0, names: [] },
            reforco: { count: 0, names: [] },
            fisico: { count: 0, names: [] },
            suporte: { count: 0, names: [] },
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
}

function own(capacity, treeId, ids, extraNodes = []) {
    const next = deepMerge(capacity, {});
    const state = treeState(treeId, ids, extraNodes);
    const names = namesFromState(state);
    if (treeId === 'suporte') {
        next.supportTree = state;
        next.treeSummaries.suporte = { count: ids.length, names };
        next.support = {
            owned: ids.map((id) => state.tree.nodesById[id]).filter(Boolean),
            ownedNames: names,
        };
    } else {
        next.trees[treeId] = state;
        next.treeSummaries[treeId] = { count: ids.length, names };
    }
    return next;
}

function riskLists(capacity) {
    const states = [...Object.values(capacity.trees || {}), capacity.supportTree].filter(Boolean);
    const nodes = states.flatMap((state) => state.ownedIds.map((id) => state.tree.nodesById[id]).filter(Boolean));
    return {
        approvalNodes: nodes.filter((node) => node.requiresApproval).map((node) => `${node.name} (aprovação)`),
        highRiskNodes: nodes.filter((node) => ['alto', 'extremo'].includes(node.metadata?.risk)).map((node) => `${node.name} (${node.metadata.risk})`),
    };
}

function buildScenarios() {
    const empty = baseCapacity();

    const creationIds = ['criacao', 'controle', 'estrutura', 'forca_magica_i', 'forca_magica_ii', 'densidade_i', 'precisao_i'];
    let creation = own(baseCapacity(), 'criacao', creationIds);
    creation = deepMerge(creation, {
        creation: { flags: { base: true, control: true, structure: true, forceLevel: 2, densityLevel: 1, precisionLevel: 1 } },
    });

    const oneOffManaIds = [
        'mana', 'percepcao_de_mana', 'sentir_mana_i', 'sentir_mana_ii', 'leitura_de_flutuacao',
        'fluxo_de_mana_i', 'circulacao', 'estabilidade', 'ritmo_de_mana', 'controle_fino_i',
        'controle_fino_ii', 'voo_de_vassoura', 'retencao_de_mana_i', 'recuperacao_i',
        'recuperacao_ii', 'recuperacao_iii', 'ocultacao_de_mana', 'nucleo_de_mana',
        'condutor', 'reservatorio', 'dominador',
    ];
    let oneOffMana = own(baseCapacity(), 'mana', oneOffManaIds);
    oneOffMana = deepMerge(oneOffMana, {
        mana: { flags: {
            base: true, perception: true, sensing: true, sensingLevel: 2,
            flow: true, circulation: true, stability: true, retention: true,
            recoveryLevel: 3, fineControl: true, fineControlLevel: 2,
        } },
    });

    let full = baseCapacity();
    full = own(full, 'mana', TREES.mana.nodes.map((node) => node.id));
    full = own(full, 'criacao', TREES.criacao.nodes.map((node) => node.id));
    full = own(full, 'reforco', TREES.reforco.nodes.map((node) => node.id));
    full = own(full, 'fisico', TREES.fisico.nodes.map((node) => node.id));
    full = own(full, 'suporte', TREES.suporte.nodes.map((node) => node.id));
    full = deepMerge(full, {
        creation: { flags: {
            base: true, control: true, structure: true, junction: true,
            forceLevel: 3, speedLevel: 3, defenseLevel: 3, densityLevel: 3,
            precisionLevel: 3, weaponsLevel: 3, humanoidsLevel: 3, environmentLevel: 3,
        } },
        reinforcement: { flags: {
            base: true, intensityLevel: 3, stabilityLevel: 3, focusCount: 3,
            attributes: ['Força', 'Velocidade', 'Agilidade', 'Resistência', 'Defesa'],
            selfBuff: true, otherBuff: true, touchBuff: true, distanceBuff: true,
            collectiveBuff: true, junction: true, advanced: true,
            advancedWeapons: true, advancedHumanoids: true, advancedEnvironment: true,
        } },
        mana: { flags: {
            base: true, perception: true, sensing: true, sensingLevel: 3,
            signature: true, flow: true, circulation: true, stability: true,
            channeling: true, emission: true, retention: true,
            bulletLevel: 3, pulseLevel: 3, manaSkin: true, manaSkinLevel: 3,
            manaMantle: true, field: true, fieldLevel: 3,
            economy: true, economyLevel: 2, recoveryLevel: 3,
            environmentalReading: true, environmentalAdaptation: true,
            environment: true, environmentLevel: 3, resonance: true, method: true,
            zone: true, zoneLevel: 3, domain: true, fineControl: true,
            fineControlLevel: 3, compression: true, objectCoating: true,
            simultaneousMaintenance: true, pressure: true,
        } },
        physical: {
            flags: {
                base: true, vigor: true, control: true, perception: true,
                antiMage: true, ki: true, zetten: true, apex: true,
            },
            levels: {
                strength: 4, resistance: 4, conditioning: 4, mobility: 4,
                reflexes: 4, precision: 4,
                senses: { visao: 5, audicao: 5, olfato: 5, tato: 5, paladar: 5, intuicao: 5 },
                identities: { barbarian: 2, tyrant: 2, benevolent: 2, cult: 2, just: 2, unjust: 2, instinct: 2 },
            },
        },
    });
    Object.assign(full, riskLists(full));

    const futureNode = {
        id: 'no_futuro_de_teste',
        name: 'Nó Futuro de Teste',
        route: 'teste',
        tier: 99,
        shortEffect: 'Efeito novo ainda não catalogado, mas que precisa aparecer.',
        effect: 'Efeito novo ainda não catalogado, mas que precisa aparecer.',
        requiresApproval: true,
        metadata: { technicalWeight: 4, risk: 'alto' },
    };
    let fallback = own(baseCapacity(), 'mana', ['mana', futureNode.id], [futureNode]);
    fallback = deepMerge(fallback, { mana: { flags: { base: true } } });

    return [
        {
            name: 'iniciante vazio',
            capacity: empty,
            required: ['Sem avanço relevante em Mana comprado', 'O uso básico fica em PB'],
        },
        {
            name: 'criação com buff II',
            capacity: creation,
            required: ['Força Mágica I: +10%', 'Força Mágica II: +20%', 'Força Mágica III: +30%', 'não comprado'],
        },
        {
            name: 'nós de Mana complementares',
            capacity: oneOffMana,
            required: ['Leitura de Flutuação', 'Ritmo de Mana', 'Voo de Vassoura', 'Ocultação de Mana', 'Núcleo de Mana', 'Condutor', 'Reservatório', 'Dominador'],
        },
        {
            name: 'personagem máximo',
            capacity: full,
            required: ['Pele de Mana III: Peso 2', 'Economia de Mana II: -10%', 'Magia Proibida', 'Autobuff de 3 atributo(s): Peso 8'],
        },
        {
            name: 'fallback de nó futuro',
            capacity: fallback,
            required: ['Nó Futuro de Teste', 'Efeito novo ainda não catalogado', 'Peso técnico de Nó Futuro de Teste: +4'],
        },
    ];
}

function longestLine(output) {
    return String(output).split('\n').reduce((max, line) => Math.max(max, line.length), 0);
}

function validate(label, output, required, limit) {
    assert.strictEqual(typeof output, 'string', `${label}: saída não é string`);
    assert(output.length > 200, `${label}: saída curta demais`);
    assert(output.length < limit, `${label}: saída grande demais (${output.length})`);
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
        let player = '';
        let technical = '';
        const errors = [];
        try {
            player = formatPlayerCapacity(scenario.capacity);
            technical = formatTechnicalCapacity(scenario.capacity, { full: true, admin: true });
            validate(`${scenario.name} / player`, player, ['CAPACIDADE ATUAL', 'PB básico', 'O uso básico fica em PB'], PLAYER_LIMIT);
            validate(`${scenario.name} / técnico`, technical, ['CAPACIDADE TÉCNICA', 'PER 1', 'Teto comum sugerido'], TECHNICAL_LIMIT);
            validate(`${scenario.name} / conteúdo`, `${player}\n${technical}`, scenario.required, HARD_LIMIT);
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
