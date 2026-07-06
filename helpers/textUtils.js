const DECORATIVE_CHAR_MAP = {
    'α': 'a',
    'ᥱ': 'e',
    'ı': 'i',
    'ɯ': 'w',
    'ч': 'y',
    '𝟢': '0',
    '𝟣': '1',
    '𝟤': '2',
    '𝟥': '3',
    '𝟦': '4',
    '𝟧': '5',
    '𝟨': '6',
    '𝟩': '7',
    '𝟪': '8',
    '𝟫': '9',
};

function replaceDecorativeChars(value) {
    return [...String(value || '')]
        .map((char) => DECORATIVE_CHAR_MAP[char] || char)
        .join('');
}

function normalizeText(value) {
    return replaceDecorativeChars(
        String(value || '')
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
    ).trim();
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

function levenshteinDistance(a, b) {
    const left = String(a || '');
    const right = String(b || '');
    const matrix = Array.from({ length: left.length + 1 }, () => []);

    for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i;
    for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j;

    for (let i = 1; i <= left.length; i += 1) {
        for (let j = 1; j <= right.length; j += 1) {
            const cost = left[i - 1] === right[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );
        }
    }

    return matrix[left.length][right.length];
}

function getClosestTextMatches(input, candidates, limit = 3) {
    const normalizedInput = normalizeText(input).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normalizedInput) return [];

    return candidates
        .map((candidate) => {
            const label = String(candidate?.label || candidate?.name || candidate || '');
            const key = String(candidate?.key || '');
            const normalizedLabel = normalizeText(label).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
            const normalizedKey = normalizeText(key).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
            const labelDistance = levenshteinDistance(normalizedInput, normalizedLabel);
            const keyDistance = normalizedKey ? levenshteinDistance(normalizedInput, normalizedKey) : labelDistance;
            const containsBonus = normalizedLabel.includes(normalizedInput) || normalizedInput.includes(normalizedLabel) ? -3 : 0;

            return {
                label,
                score: Math.min(labelDistance, keyDistance) + containsBonus,
            };
        })
        .filter((item) => item.label)
        .sort((a, b) => a.score - b.score || a.label.localeCompare(b.label))
        .slice(0, limit)
        .map((item) => item.label);
}

module.exports = {
    collapseWhitespace,
    getClosestTextMatches,
    normalizeCommandText,
    normalizeText,
    replaceDecorativeChars,
    stripMarkdown,
    unique,
};
