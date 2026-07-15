'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    formatPlayerCapacity,
    formatTechnicalCapacity,
} = require('../helpers/clover/capacityCatalogPresentation');

const ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts', 'capacity-catalog');
const PLAYER_SOFT_LIMIT = 20000;
const TECHNICAL_SOFT_LIMIT = 50000;
const WHATSAPP_HARD_LIMIT = 60000;

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
        mustContain: [
            'Força Mágica I: +10% em dano de criação — comprado.',
            'Força Mágica II: +20% em dano de criação — atual.',
            'Força Mágica III: +30% em dano de criação — não comprado.',
            'Ofensiva + Força II',
        ],
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
                    junction: true,
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
                    environmentalReading: true,
                    environmentalAdaptation: true,
                    environment: true,
                    environmentLevel: 1,
                    resonance: true,
                    method: true,
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

function countLines(output) {
    return String(output).split('\n').length;
}

function longestLine(output) {
    return String(output)
        .split('\n')
        .reduce((longest, line) => Math.max(longest, line.length), 0);
}

function assertOutput(name, output, required, softLimit) {
    assert.strictEqual(typeof output, 'string', `${name}: saída precisa ser string`);
    assert(output.length > 200, `${name}: saída curta demais`);
    assert(output.length < WHATSAPP_HARD_LIMIT, `${name}: ultrapassa limite técnico de mensagem`);
    assert(output.length < softLimit, `${name}: grande demais para a função proposta`);
    assert(longestLine(output) < 1000, `${name}: existe linha longa demais sem quebra`);
    assert(!output.includes('undefined'), `${name}: saída contém undefined`);
    assert(!output.includes('[object Object]'), `${name}: saída contém [object Object]`);
    assert(!output.includes('NaN'), `${name}: saída contém NaN`);
    for (const token of required) {
        assert(output.includes(token), `${name}: saída não contém ${JSON.stringify(token)}`);
    }
}

function ensureArtifactDir() {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

function writeArtifacts(results) {
    ensureArtifactDir();

    const snapshot = results.flatMap((result) => [
        '='.repeat(80),
        result.name.toUpperCase(),
        '='.repeat(80),
        '',
        '.CAPACIDADE',
        '',
        result.playerOutput,
        '',
        '.CAPACIDADE TÉCNICA',
        '',
        result.technicalOutput,
        '',
    ]).join('\n');

    fs.writeFileSync(
        path.join(ARTIFACT_DIR, 'capacity-output-snapshots.txt'),
        `${snapshot}\n`,
        'utf8'
    );

    const report = {
        generatedAt: new Date().toISOString(),
        scenarios: results.map((result) => ({
            name: result.name,
            passed: result.errors.length === 0,
            errors: result.errors,
            player: {
                characters: result.playerOutput.length,
                lines: countLines(result.playerOutput),
                longestLine: longestLine(result.playerOutput),
            },
            technical: {
                characters: result.technicalOutput.length,
                lines: countLines(result.technicalOutput),
                longestLine: longestLine(result.technicalOutput),
            },
        })),
    };
    report.summary = {
        total: report.scenarios.length,
        passed: report.scenarios.filter((scenario) => scenario.passed).length,
        failed: report.scenarios.filter((scenario) => !scenario.passed).length,
    };

    fs.writeFileSync(
        path.join(ARTIFACT_DIR, 'simulation-report.json'),
        `${JSON.stringify(report, null, 2)}\n`,
        'utf8'
    );
}

function main() {
    const results = [];

    for (const scenario of scenarios) {
        let playerOutput = '';
        let technicalOutput = '';
        const errors = [];

        try {
            playerOutput = formatPlayerCapacity(scenario.capacity);
            technicalOutput = formatTechnicalCapacity(scenario.capacity, { full: true, admin: true });
            assertOutput(
                `${scenario.name} / .capacidade`,
                playerOutput,
                ['CAPACIDADE ATUAL', 'Resumo'],
                PLAYER_SOFT_LIMIT
            );
            assertOutput(
                `${scenario.name} / .capacidade técnica`,
                technicalOutput,
                ['CAPACIDADE TÉCNICA', 'Hexágono', 'Manutenção'],
                TECHNICAL_SOFT_LIMIT
            );
            assertOutput(
                `${scenario.name} / tokens`,
                `${playerOutput}\n${technicalOutput}`,
                scenario.mustContain,
                WHATSAPP_HARD_LIMIT
            );
        } catch (error) {
            errors.push(error?.message || String(error));
        }

        results.push({
            name: scenario.name,
            playerOutput,
            technicalOutput,
            errors,
        });

        if (errors.length) {
            console.error(`✕ ${scenario.name}`);
            errors.forEach((error) => console.error(`  - ${error}`));
        } else {
            console.log(`✓ ${scenario.name}`);
        }
    }

    writeArtifacts(results);

    const failed = results.filter((result) => result.errors.length > 0);
    if (failed.length) {
        console.error(`\nResultado: ${failed.length}/${results.length} simulações falharam.`);
        process.exitCode = 1;
        return;
    }

    console.log(`\nResultado: ${results.length} simulações passaram.`);
}

main();
