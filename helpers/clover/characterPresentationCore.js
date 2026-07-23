'use strict';

const PRESENTATION_SCHEMA_VERSION = 'character-presentation.v1';
const AUDIENCES = new Set(['player', 'narrator', 'admin']);
const EMPTY_VALUES = new Set([
    '', '-', '—', '–', 'null', 'undefined', 'none', 'n/a', 'na', 'nenhum', 'nenhuma',
]);

function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function list(value) {
    return Array.isArray(value) ? value : [];
}

function repairDisplayText(value) {
    const text = String(value ?? '');
    if (!/[ÃÂ]/.test(text)) return text;
    try {
        const repaired = Buffer.from(text, 'latin1').toString('utf8');
        return repaired && !repaired.includes('�') ? repaired : text;
    } catch {
        return text;
    }
}

function cleanText(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = repairDisplayText(String(value)).trim();
    if (!text || EMPTY_VALUES.has(text.toLowerCase())) return null;
    return text;
}

function numberValue(...values) {
    for (const value of values) {
        const parsed = typeof value === 'string' ? Number(value) : value;
        if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function normalizedKey(value) {
    const text = cleanText(value);
    if (!text) return '';
    return text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function uniqueBy(items, keyBuilder) {
    const seen = new Set();
    return items.filter((item) => {
        const key = keyBuilder(item);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function textList(value) {
    return list(value)
        .map((entry) => {
            if (typeof entry === 'string' || typeof entry === 'number') return cleanText(entry);
            const item = record(entry);
            return cleanText(
                item.effect
                ?? item.efeito
                ?? item.description
                ?? item.descricao
                ?? item.label
                ?? item.name
                ?? item.nome
                ?? item.value
                ?? item.valor
            );
        })
        .filter(Boolean);
}

function sourceLabel(value, fallback = null) {
    return cleanText(value) || fallback;
}

function presentFamily(rawFamily) {
    if (typeof rawFamily === 'string' || typeof rawFamily === 'number') {
        const name = cleanText(rawFamily);
        return name ? { name, summary: null, notes: [] } : null;
    }

    const family = record(rawFamily);
    const details = record(family.details);
    const name = cleanText(family.label ?? family.name ?? family.nome);
    if (!name) return null;

    const summary = cleanText(
        details.summary
        ?? details.resumo
        ?? family.summary
        ?? family.description
        ?? family.descricao
    );
    const notes = uniqueBy(
        [
            ...textList(family.notes),
            ...textList(details.notes),
            ...textList(details.notas),
        ].map((text) => ({ text })),
        (item) => normalizedKey(item.text)
    ).map((item) => item.text);

    return { name, summary, notes };
}

module.exports = {
    AUDIENCES,
    PRESENTATION_SCHEMA_VERSION,
    cleanText,
    list,
    normalizedKey,
    numberValue,
    presentFamily,
    record,
    repairDisplayText,
    sourceLabel,
    textList,
    uniqueBy,
};
