function normalizeText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function collapseWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeCommandText(value) {
    return collapseWhitespace(normalizeText(value));
}

function stripMarkdown(value) {
    return String(value || '')
        .replace(/[*_`~]/g, '')
        .replace(/[>#]/g, ' ')
        .trim();
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

module.exports = {
    normalizeText,
    collapseWhitespace,
    normalizeCommandText,
    stripMarkdown,
    unique,
};
