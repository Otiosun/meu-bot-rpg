'use strict';

function cleanText(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).trim();
    return text || null;
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

function templateKeyFromName(value) {
    return normalizedKey(value).replace(/\s+/g, '_') || null;
}

function splitParentheticalItem(value, fallbackDescription = null) {
    const merged = cleanText(value);
    const fallback = cleanText(fallbackDescription);
    if (!merged) return { itemName: null, description: fallback };

    const match = merged.match(/^(.+?)\s*\(([^]*)\)$/);
    if (!match) return { itemName: merged, description: fallback };

    const itemName = cleanText(match[1]);
    const parenthetical = cleanText(match[2]);
    if (!itemName || !parenthetical) return { itemName: merged, description: fallback };

    return {
        itemName,
        description: fallback || parenthetical,
    };
}

function isPlaceholderDescription(value) {
    const text = cleanText(value);
    if (!text) return true;
    const normalized = normalizedKey(text);
    if (/^recompensa\b/.test(normalized)) return true;
    if (/^(item|premio|recompensa) (de|do|da)\b/.test(normalized)) return true;
    return text.length < 30;
}

function hasStandaloneSpecification(itemInput) {
    const item = itemInput && typeof itemInput === 'object' ? itemInput : {};
    return Boolean(
        cleanText(item.itemName)
        && cleanText(item.category)
        && cleanText(item.kind)
        && !isPlaceholderDescription(item.description)
    );
}

module.exports = {
    cleanText,
    hasStandaloneSpecification,
    isPlaceholderDescription,
    normalizedKey,
    splitParentheticalItem,
    templateKeyFromName,
};
