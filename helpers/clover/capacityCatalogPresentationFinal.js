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
    supportPlayerLines,
    supportTechnicalLines,
} = require('./capacityCatalogEnhancements');

const TREE_LABELS = {
    mana: '𝑴𝒂𝒏𝒂',
    criacao: '𝑪𝒓𝒊𝒂𝒄̧𝒂̃𝒐',
    reforco: '𝑹𝒆𝒇𝒐𝒓𝒄̧𝒐',
    fisico: '𝑭𝒊́𝒔𝒊𝒄𝒐',
};

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

    return [
        output,
        '',
        section('✓', '𝑹𝒆𝒔𝒖𝒎𝒐 𝑮𝒆𝒓𝒂𝒍'),
        '',
        `> ${finalPlayerSummary(capacity)}`,
    ].join('\n');
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

    output = correctKnownCostLines(output, capacity)
        .replace(/\bapproval\b/g, 'aprovação')
        .replace('decisão manual da ADM', 'decisão manual do ADM');

    return [
        output,
        '',
        section('✓', '𝑹𝒆𝒔𝒖𝒎𝒐 𝑻𝒆́𝒄𝒏𝒊𝒄𝒐'),
        '',
        `> ${finalTechnicalSummary(capacity)}`,
    ].join('\n');
}

module.exports = {
    formatPlayerCapacity,
    formatTechnicalCapacity,
};
