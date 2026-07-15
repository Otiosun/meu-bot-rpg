'use strict';

const {
    formatPlayerCapacity: formatBasePlayerCapacity,
    formatTechnicalCapacity: formatBaseTechnicalCapacity,
} = require('./capacityCatalogPresentation');
const {
    correctKnownCostLines,
    finalPlayerSummary,
    finalTechnicalSummary,
    hasManaProgress,
    list,
    section,
    supplementalPlayerSections,
    supplementalTechnicalSections,
} = require('./capacityCatalogEnhancements');
const {
    supportPlayerLines,
    supportTechnicalLines,
} = require('./capacitySupportCatalog');
const { calculateRankCost } = require('./balanceGuide');

const TREE_LABELS = {
    mana: '𝑴𝒂𝒏𝒂',
    criacao: '𝑪𝒓𝒊𝒂𝒄̧𝒂̃𝒐',
    reforco: '𝑹𝒆𝒇𝒐𝒓𝒄̧𝒐',
    fisico: '𝑭𝒊́𝒔𝒊𝒄𝒐',
};

const TEXT_REPLACEMENTS = [
    ['Leitura de Flutuacao', 'Leitura de Flutuação'],
    ['Ocultacao de Mana', 'Ocultação de Mana'],
    ['Nucleo de Mana', 'Núcleo de Mana'],
    ['Reservatorio', 'Reservatório'],
    ['Percepcao de Mana', 'Percepção de Mana'],
    ['Retencao de Mana', 'Retenção de Mana'],
    ['Emissao de Mana', 'Emissão de Mana'],
    ['Circulacao', 'Circulação'],
    ['Canalizacao', 'Canalização'],
    ['Adaptacao Ambiental', 'Adaptação Ambiental'],
    ['Ressonancia', 'Ressonância'],
    ['Metodo de Mana', 'Método de Mana'],
    ['Compressao de Mana', 'Compressão de Mana'],
    ['Manutencao Simultanea', 'Manutenção Simultânea'],
    ['Mana Zone', 'Zona de Mana'],
    ['decisao manual', 'decisão manual'],
    ['formulas', 'fórmulas'],
    ['condicoes', 'condições'],
    ['bencaos', 'bênçãos'],
];

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function polishText(value) {
    let output = String(value || '');
    for (const [from, to] of TEXT_REPLACEMENTS) {
        output = output.split(from).join(to);
    }
    output = output
        .replace(/\bMANA\b/g, 'Mana')
        .replace(/\nSem (Criação|Reforço|Físico) comprad([oa])\./g, '\n> Sem $1 comprad$2.')
        .replace(/\n{3,}/g, '\n\n');
    return output;
}

function replaceSection(text, startMarker, endMarker, replacementLines) {
    const source = String(text || '');
    const start = source.indexOf(startMarker);
    if (start < 0) return source;
    const end = source.indexOf(endMarker, start + startMarker.length);
    if (end < 0) return source;
    const body = Array.isArray(replacementLines) ? replacementLines.join('\n') : String(replacementLines || '');
    return `${source.slice(0, start)}${startMarker}\n\n${body}\n\n${source.slice(end)}`;
}

function insertBefore(text, marker, block) {
    const source = String(text || '');
    const index = source.indexOf(marker);
    if (index < 0) return `${source}\n\n${block}`;
    return `${source.slice(0, index)}${block}\n\n${source.slice(index)}`;
}

function hasLoadedTreeStates(capacity) {
    return Boolean(capacity?.trees && Object.values(capacity.trees).some(Boolean));
}

function playerSupplementBlock(capacity) {
    const sections = supplementalPlayerSections(capacity);
    if (!sections.length) return '';
    const lines = [section('⌁', '𝑨𝒗𝒂𝒏𝒄̧𝒐𝒔 𝑪𝒐𝒎𝒑𝒍𝒆𝒎𝒆𝒏𝒕𝒂𝒓𝒆𝒔'), ''];
    for (const entry of sections) {
        lines.push(`*${TREE_LABELS[entry.treeId] || entry.treeId}:*`, list(entry.lines));
    }
    return lines.join('\n');
}

function technicalSupplementBlock(capacity) {
    const sections = supplementalTechnicalSections(capacity);
    if (!sections.length) return '';
    const lines = [section('⌁', '𝑨𝒗𝒂𝒏𝒄̧𝒐𝒔 𝑪𝒐𝒎𝒑𝒍𝒆𝒎𝒆𝒏𝒕𝒂𝒓𝒆𝒔'), ''];
    for (const entry of sections) {
        lines.push(`*${TREE_LABELS[entry.treeId] || entry.treeId}:*`, list(entry.lines));
    }
    return lines.join('\n');
}

function currentLevels(capacity) {
    const creation = capacity?.creation?.flags || {};
    const reinforcement = capacity?.reinforcement?.flags || {};
    const mana = capacity?.mana?.flags || {};
    const physical = capacity?.physical?.levels || {};
    return [
        ['Força Mágica', creation.forceLevel],
        ['Velocidade Mágica', creation.speedLevel],
        ['Defesa Mágica', creation.defenseLevel],
        ['Densidade', creation.densityLevel],
        ['Precisão', creation.precisionLevel],
        ['Armas', creation.weaponsLevel],
        ['Formas Humanoides', creation.humanoidsLevel],
        ['Ambiente', creation.environmentLevel],
        ['Intensidade', reinforcement.intensityLevel],
        ['Estabilidade', reinforcement.stabilityLevel],
        ['Sentir Mana', mana.sensingLevel],
        ['Bala de Mana', mana.bulletLevel],
        ['Pulso de Mana', mana.pulseLevel],
        ['Pele de Mana', mana.manaSkinLevel],
        ['Campo de Mana', mana.fieldLevel],
        ['Economia de Mana', mana.economyLevel],
        ['Recuperação', mana.recoveryLevel],
        ['Ambiente de Mana', mana.environmentLevel],
        ['Mana Zone', mana.zoneLevel],
        ['Controle Fino', mana.fineControlLevel],
        ['Força Aplicada', physical.strength],
        ['Resistência Corporal', physical.resistance],
        ['Condicionamento Físico', physical.conditioning],
        ['Mobilidade', physical.mobility],
        ['Reflexos Corporais', physical.reflexes],
        ['Precisão Técnica', physical.precision],
    ];
}

function removeUnusedLadderLines(text, capacity) {
    let output = String(text || '');
    for (const [label, level] of currentLevels(capacity)) {
        if (Number(level || 0) > 0) continue;
        output = output.replace(
            new RegExp(`^> ${escapeRegex(label)} I:[^\\n]*— não comprado\\.\\n?`, 'gm'),
            ''
        );
    }
    output = output
        .replace(/\*Escada comprada \/ próximo nível:\*\n\n(?=\*(?:Peso|Pesos))/g, '')
        .replace(/\*Escada de buffs físicos:\*\n\n(?=\*Onde entra|\*Custo e uso)/g, '');
    return output;
}

function costLine(label, weight, note = '') {
    const cost = calculateRankCost(weight);
    const mana = cost.special ? 'especial' : `${cost.totalMana} mana`;
    return `> ${label}: Peso ${weight} → Rank ${cost.rank} → ${mana}${note ? ` | ${note}` : ''}`;
}

function replaceCostLine(output, label, replacement) {
    return output.replace(
        new RegExp(`> ${escapeRegex(label)}: Peso \\d+ → Rank [A-Z] → [^\\n]+`),
        replacement
    );
}

function correctAdditionalCosts(text, capacity) {
    let output = String(text || '');
    const creation = capacity?.creation?.flags || {};
    const reinforcement = capacity?.reinforcement?.flags || {};
    if (creation.junction) {
        output = replaceCostLine(output, 'Forma com Junção de Forma', costLine('Forma com Junção de Forma', 4, 'depende da combinação real'));
    }
    if (creation.environmentLevel) {
        const label = `Área/Campo com Ambiente ${['', 'I', 'II', 'III'][creation.environmentLevel]}`;
        output = replaceCostLine(output, label, costLine(label, 3 + creation.environmentLevel, 'normalmente exige manutenção média ou pesada'));
    }
    if (reinforcement.attributes?.length && reinforcement.selfBuff) {
        const count = Math.min(reinforcement.focusCount || 1, reinforcement.attributes.length);
        const label = `Autobuff de ${count} atributo(s)`;
        const weight = 2 + Math.max(1, Number(reinforcement.intensityLevel || 1)) + count;
        output = replaceCostLine(output, label, costLine(label, weight, 'manutenção leve/média'));
    }
    return output;
}

function correctEconomyText(text, capacity) {
    let output = String(text || '');
    const current = Number(capacity?.mana?.flags?.economyLevel || 0);
    const reductions = [0, 5, 10, 15];
    if (current > 0) {
        const roman = ['', 'I', 'II', 'III'][current];
        output = output.replace(
            new RegExp(`Economia de Mana ${roman}: reduz gasto real quando o uso combina\\.`),
            `Economia de Mana ${roman}: reduz em ${reductions[current]}% o gasto real quando o uso combina.`
        );
    }
    for (let level = 1; level <= 3; level += 1) {
        const roman = ['', 'I', 'II', 'III'][level];
        output = output.replace(
            new RegExp(`Economia de Mana ${roman}: nível ${roman} em redução de gasto real`, 'g'),
            `Economia de Mana ${roman}: -${reductions[level]}% no gasto real`
        );
    }
    return output;
}

function formatPlayerCapacity(capacity) {
    let output = formatBasePlayerCapacity(capacity);
    if (!capacity?.ok) return output;

    output = replaceSection(
        output,
        section('✧', '𝑺𝒖𝒑𝒐𝒓𝒕𝒆'),
        section('!', '𝑳𝒊𝒎𝒊𝒕𝒆𝒔 𝑹𝒂́𝒑𝒊𝒅𝒐𝒔'),
        list(supportPlayerLines(capacity))
    );

    const supplement = hasLoadedTreeStates(capacity) ? playerSupplementBlock(capacity) : '';
    if (supplement) {
        output = insertBefore(output, section('!', '𝑳𝒊𝒎𝒊𝒕𝒆𝒔 𝑹𝒂́𝒑𝒊𝒅𝒐𝒔'), supplement);
    }

    output = correctEconomyText(output, capacity);

    return polishText([
        output,
        '',
        section('✓', '𝑹𝒆𝒔𝒖𝒎𝒐 𝑮𝒆𝒓𝒂𝒍'),
        '',
        `> ${finalPlayerSummary(capacity)}`,
    ].join('\n'));
}

function formatTechnicalCapacity(capacity, options = {}) {
    let output = formatBaseTechnicalCapacity(capacity, options);
    if (!capacity?.ok) return output;

    if (!hasManaProgress(capacity)) {
        output = replaceSection(
            output,
            section('✧', '𝑴𝒂𝒏𝒂'),
            section('■', '𝑭𝒊́𝒔𝒊𝒄𝒐'),
            '> Sem avanço relevante em Mana comprado.'
        );
    }

    output = replaceSection(
        output,
        section('✩', '𝑺𝒖𝒑𝒐𝒓𝒕𝒆'),
        section('!', '𝑨𝒕𝒆𝒏𝒄̧𝒐̃𝒆𝒔'),
        supportTechnicalLines(capacity)
    );

    const supplement = hasLoadedTreeStates(capacity) ? technicalSupplementBlock(capacity) : '';
    if (supplement) {
        output = insertBefore(output, section('!', '𝑨𝒕𝒆𝒏𝒄̧𝒐̃𝒆𝒔'), supplement);
    }

    output = removeUnusedLadderLines(output, capacity);
    output = correctKnownCostLines(output, capacity);
    output = correctAdditionalCosts(output, capacity);
    output = correctEconomyText(output, capacity)
        .replace(/\bapproval\b/g, 'aprovação')
        .replace('decisão manual da ADM', 'decisão manual do ADM');

    return polishText([
        output,
        '',
        section('✓', '𝑹𝒆𝒔𝒖𝒎𝒐 𝑻𝒆́𝒄𝒏𝒊𝒄𝒐'),
        '',
        `> ${finalTechnicalSummary(capacity)}`,
    ].join('\n'));
}

module.exports = {
    formatPlayerCapacity,
    formatTechnicalCapacity,
};
