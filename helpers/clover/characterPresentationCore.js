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

function isAbsenceText(value, context = 'generic') {
    const key = normalizedKey(value);
    if (!key) return true;
    if (['nao informado', 'nao informada', 'nao cadastrado', 'nao cadastrada', 'nao definido', 'nao definida', 'a definir'].includes(key)) {
        return true;
    }

    const contextPatterns = {
        family: [
            /^sem (linhagem|familia)( registrada| cadastrada| informada)?$/,
            /^(nenhuma|nenhum) (linhagem|familia)( registrada| cadastrada| informada)?$/,
        ],
        hook: [
            /^sem gancho( narrativo)?( registrado| cadastrado| informado| definido)?$/,
            /^(nenhum|nenhuma) gancho( narrativo)?( registrado| cadastrado| informado| definido)?$/,
            /^nao possui gancho( narrativo)?$/,
        ],
        trait: [
            /^sem (traco|aptidao|marca|anomalia)( registrado| cadastrada| cadastrado| informada| informado)?$/,
            /^(nenhum|nenhuma) (traco|aptidao|marca|anomalia)( registrado| cadastrada| cadastrado| informada| informado)?$/,
            /^nao possui (traco|aptidao|marca|anomalia)$/,
        ],
        narrative_item: [
            /^sem (item|objeto)( narrativo)?( registrado| cadastrado| informado)?$/,
            /^(nenhum|nenhuma) (item|objeto)( narrativo)?( registrado| cadastrado| informado)?$/,
        ],
    };

    return (contextPatterns[context] || []).some((pattern) => pattern.test(key));
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
        return name && !isAbsenceText(name, 'family') ? { name, summary: null, notes: [] } : null;
    }

    const family = record(rawFamily);
    const details = record(family.details);
    const name = cleanText(family.label ?? family.name ?? family.nome);
    if (!name || isAbsenceText(name, 'family')) return null;

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
    isAbsenceText,
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