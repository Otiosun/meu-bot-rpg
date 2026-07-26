'use strict';

function cleanText(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).trim();
    return text || null;
}

function normalizedText(value) {
    const text = cleanText(value);
    if (!text) return '';
    return text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function uniqueHighCandidates(template) {
    const candidates = Array.isArray(template?.candidates) ? template.candidates : [];
    const high = candidates.filter((candidate) => candidate?.confidence === 'high' && cleanText(candidate.description));
    const groups = new Map();
    for (const candidate of high) {
        const key = normalizedText(candidate.description);
        const current = groups.get(key) || [];
        current.push(candidate);
        groups.set(key, current);
    }
    return [...groups.values()];
}

function buildTraitDescriptionRepairPlan(reportInput) {
    const report = reportInput && typeof reportInput === 'object' ? reportInput : {};
    const templates = Array.isArray(report.templates) ? report.templates : [];
    const ready = [];
    const manualReview = [];
    const skipped = [];

    for (const template of templates) {
        const templateId = cleanText(template?.id);
        const templateName = cleanText(template?.name);
        if (!templateId || !templateName) {
            skipped.push({
                templateId,
                templateName,
                reason: 'Modelo sem identidade suficiente no relatório.',
            });
            continue;
        }
        if (cleanText(template.description)) {
            skipped.push({
                templateId,
                templateName,
                reason: 'O modelo já possui descrição.',
            });
            continue;
        }

        const groups = uniqueHighCandidates(template);
        if (groups.length === 0) {
            manualReview.push({
                templateId,
                templateName,
                slotKey: cleanText(template.slotKey),
                reason: 'Nenhum candidato de alta confiança.',
                candidateCount: Array.isArray(template.candidates) ? template.candidates.length : 0,
            });
            continue;
        }
        if (groups.length > 1) {
            manualReview.push({
                templateId,
                templateName,
                slotKey: cleanText(template.slotKey),
                reason: 'Candidatos de alta confiança possuem descrições conflitantes.',
                variants: groups.map((group) => ({
                    description: group[0].description,
                    sources: group.map((candidate) => ({
                        source: candidate.source,
                        sourceRef: candidate.sourceRef || null,
                        templateId: candidate.templateId || null,
                    })),
                })),
            });
            continue;
        }

        const group = groups[0];
        const primary = group[0];
        const effects = [...new Set(group.map((candidate) => normalizedText(candidate.effect)).filter(Boolean))];
        const restrictions = [...new Set(group.map((candidate) => normalizedText(candidate.restrictions)).filter(Boolean))];
        ready.push({
            operation: 'trait_template.description.propose',
            templateId,
            templateName,
            slotKey: cleanText(template.slotKey),
            currentDescription: null,
            proposedDescription: primary.description,
            proposedEffect: effects.length === 1 ? cleanText(group.find((candidate) => cleanText(candidate.effect))?.effect) : null,
            proposedRestrictions: restrictions.length === 1
                ? cleanText(group.find((candidate) => cleanText(candidate.restrictions))?.restrictions)
                : null,
            evidence: group.map((candidate) => ({
                source: candidate.source,
                reason: candidate.reason,
                sourceRef: candidate.sourceRef || null,
                sourceTemplateId: candidate.templateId || null,
                sourceSlotKey: candidate.sourceSlotKey || null,
                playerKey: candidate.playerKey || null,
                characterName: candidate.characterName || null,
            })),
            requiresManualApproval: true,
        });
    }

    return {
        generatedAt: new Date().toISOString(),
        mode: 'dry-run',
        writesPerformed: false,
        summary: {
            templatesReviewed: templates.length,
            readyForManualApproval: ready.length,
            manualReview: manualReview.length,
            skipped: skipped.length,
        },
        ready,
        manualReview,
        skipped,
    };
}

module.exports = {
    buildTraitDescriptionRepairPlan,
    cleanText,
    normalizedText,
    uniqueHighCandidates,
};
