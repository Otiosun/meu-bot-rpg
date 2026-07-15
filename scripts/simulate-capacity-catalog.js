'use strict';

const assert = require('assert');
const {
    formatPlayerCapacity,
    formatTechnicalCapacity,
} = require('../helpers/clover/capacityCatalogPresentation');

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
        support: { ownedNames: [] },
        approvalNodes: [],
        highRiskNodes: [],
        nextNodes: {
            mana: [],
            criacao: [],
            reforco: [],
            fisico: [],
        },
    };

    return deepMerge(capacity, overrides);
}

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

const scenarios = [
    {
        name: 'iniciante quase vazio',
        capacity: baseCapacity(),
        mustContain: ['CAPACIDADE ATUAL', 'PB básico', 'Ainda não tem Criação'],
    },
    {
        name: 'criação média com buffs II',
        capacity: baseCapacity({
            treeSummaries: {
                criacao: { count: 8, names: ['Criação', 'Controle', 'Estrutura', 'Força Mágica II', 'Velocidade Mágica I', 'Defesa Mágica I', 'Densidade II', 'Precisão I'] },
            },
            creation: {
                flags: {
                    base: true,
                    control: true,
                    structure: true,
                    forceLevel: 2,
                    speedLevel: 1,
                    defenseLevel: 1,
                    densityLevel: 2,
                    precisionLevel: 1,
                },
            },
        }),
        mustContain: ['Força Mágica II', '+20%', 'Peso dos níveis', 'Ofensiva + Força II'],
    },
    {
        name: 'criação avançada de área/construto',
        capacity: baseCapacity({
            treeSummaries: {
                criacao: { count: 12, names: ['Criação', 'Controle', 'Estrutura', 'Junção de Forma', 'Armas III', 'Formas Humanoides II', 'Ambiente III'] },
            },
            creation: {
                flags: {
                    base: true,
                    control: true,
                    structure: true,
                    junction: true,
                    weaponsLevel: 3,
                    humanoidsLevel: 2,
                    environmentLevel: 3,
                },
            },
            approvalNodes: ['Criação: Junção de Forma (alto | approval)', 'Criação: Ambiente III (alto | approval)'],
            highRiskNodes: ['Criação: Ambiente III (alto | approval)'],
        }),
        mustContain: ['Junção de Forma', 'Ambiente III', 'aprovação obrigatória'],
    },
    {
        name: 'reforço completo',
        capacity: baseCapacity({
            treeSummaries: {
                reforco: { count: 14, names: ['Reforço', 'Intensidade III', 'Estabilidade II', 'Força Reforçada', 'Velocidade Reforçada', 'Invencível', 'Invicto', 'Reforço Coletivo'] },
            },
            reinforcement: {
                flags: {
                    base: true,
                    intensityLevel: 3,
                    stabilityLevel: 2,
                    focusCount: 2,
                    attributes: ['Força', 'Velocidade'],
                    selfBuff: true,
                    otherBuff: true,
                    touchBuff: true,
                    distanceBuff: true,
                    collectiveBuff: true,
                    advanced: true,
                    advancedWeapons: true,
                    advancedHumanoids: true,
                    advancedEnvironment: true,
                },
            },
        }),
        mustContain: ['Intensidade III', '+30%', 'Reforço coletivo', 'Onde não entra'],
    },
    {
        name: 'mana avançada',
        capacity: baseCapacity({
            treeSummaries: {
                mana: { count: 20, names: ['Mana', 'Sentir Mana III', 'Bala de Mana III', 'Pulso de Mana II', 'Pele de Mana II', 'Campo de Mana III', 'Mana Zone II'] },
            },
            mana: {
                flags: {
                    base: true,
                    perception: true,
                    sensing: true,
                    sensingLevel: 3,
                    signature: true,
                    flow: true,
                    circulation: true,
                    stability: true,
                    channeling: true,
                    emission: true,
                    retention: true,
                    bulletLevel: 3,
                    pulseLevel: 2,
                    manaSkin: true,
                    manaSkinLevel: 2,
                    manaMantle: true,
                    field: true,
                    fieldLevel: 3,
                    economy: true,
                    economyLevel: 2,
                    recoveryLevel: 2,
                    environment: true,
                    environmentLevel: 1,
                    zone: true,
                    zoneLevel: 2,
                    fineControl: true,
                    fineControlLevel: 2,
                    compression: true,
                    objectCoating: true,
                    simultaneousMaintenance: true,
                    pressure: true,
                    domain: true,
                },
            },
        }),
        mustContain: ['Bala de Mana III', 'Mana Zone II', 'Manutenção Simultânea', 'Compressão de Mana'],
    },
    {
        name: 'físico avançado',
        capacity: baseCapacity({
            treeSummaries: {
                fisico: { count: 18, names: ['Físico', 'Força Aplicada IV', 'Resistência Corporal III', 'Mobilidade III', 'Ki', 'Zetten'] },
            },
            physical: {
                flags: {
                    base: true,
                    vigor: true,
                    control: true,
                    perception: true,
                    antiMage: true,
                    ki: true,
                    zetten: true,
                    apex: false,
                },
                levels: {
                    strength: 4,
                    resistance: 3,
                    conditioning: 2,
                    mobility: 3,
                    reflexes: 2,
                    precision: 3,
                    senses: { visao: 3, audicao: 2, intuicao: 4 },
                    identities: { barbarian: 2, cult: 1, instinct: 2 },
                },
            },
        }),
        mustContain: ['Força Aplicada IV', '+40%', 'Ki', 'Zetten'],
    },
    {
        name: 'suporte sensível',
        capacity: baseCapacity({
            treeSummaries: {
                suporte: { count: 4, names: ['Cura Leve', 'Bênção Simples', 'Selo Inicial', 'Maldição Menor'] },
            },
            support: { ownedNames: ['Cura Leve', 'Bênção Simples', 'Selo Inicial', 'Maldição Menor'] },
            approvalNodes: ['Suporte: Selo Inicial (alto | approval)', 'Suporte: Maldição Menor (alto | approval)'],
            highRiskNodes: ['Suporte: Maldição Menor (alto | approval)'],
        }),
        mustContain: ['Suporte sensível', 'condição', 'aprovação obrigatória'],
    },
];

function assertOutput(name, output, required) {
    assert.strictEqual(typeof output, 'string', `${name}: saída precisa ser string`);
    assert(output.length > 200, `${name}: saída curta demais`);
    assert(!output.includes('undefined'), `${name}: saída contém undefined`);
    assert(!output.includes('[object Object]'), `${name}: saída contém [object Object]`);
    for (const token of required) {
        assert(output.includes(token), `${name}: saída não contém ${JSON.stringify(token)}`);
    }
}

function main() {
    for (const scenario of scenarios) {
        const playerOutput = formatPlayerCapacity(scenario.capacity);
        const technicalOutput = formatTechnicalCapacity(scenario.capacity, { full: true, admin: true });
        assertOutput(`${scenario.name} / .capacidade`, playerOutput, ['CAPACIDADE ATUAL', 'Resumo']);
        assertOutput(`${scenario.name} / .capacidade técnica`, technicalOutput, ['CAPACIDADE TÉCNICA', 'Hexágono', 'Manutenção']);
        assertOutput(`${scenario.name} / tokens`, `${playerOutput}\n${technicalOutput}`, scenario.mustContain);
        console.log(`✓ ${scenario.name}`);
    }

    console.log(`\nResultado: ${scenarios.length} simulações passaram.`);
}

main();
