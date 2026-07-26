'use strict';

const crypto = require('crypto');

function cleanText(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).trim();
    return text || null;
}

function pseudonymizePlayerId(value) {
    const id = cleanText(value);
    if (!id) return null;
    const digest = crypto.createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 12).toUpperCase();
    return `P-${digest}`;
}

function sanitizeCandidate(candidateInput) {
    const candidate = candidateInput && typeof candidateInput === 'object' ? candidateInput : {};
    const { playerId, ...rest } = candidate;
    return {
        ...rest,
        playerKey: pseudonymizePlayerId(playerId),
    };
}

function sanitizeTraitDescriptionAuditReport(reportInput) {
    const report = reportInput && typeof reportInput === 'object' ? reportInput : {};
    const templates = Array.isArray(report.templates) ? report.templates : [];
    return {
        ...report,
        privacy: {
            playerIds: 'sha256-prefix',
            rawPlayerIdsIncluded: false,
            phoneNumbersIncluded: false,
            sessionsIncluded: false,
            loginCodesIncluded: false,
        },
        templates: templates.map((template) => ({
            ...template,
            candidates: Array.isArray(template?.candidates)
                ? template.candidates.map(sanitizeCandidate)
                : [],
        })),
    };
}

module.exports = {
    pseudonymizePlayerId,
    sanitizeCandidate,
    sanitizeTraitDescriptionAuditReport,
};
