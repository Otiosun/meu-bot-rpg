'use strict';

const { templateKeyFromName } = require('./legacyInventoryNormalization');

function cleanText(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).trim();
    return text || null;
}

function proposedTemplateFromSource(source) {
    return {
        templateKey: templateKeyFromName(source.itemName),
        itemName: cleanText(source.itemName),
        description: cleanText(source.description),
        category: cleanText(source.category),
        kind: cleanText(source.kind),
        origin: cleanText(source.origin),
        transferable: source.transferable === null || source.transferable === undefined
            ? null
            : Number(source.transferable),
        properties: source.properties && typeof source.properties === 'object' ? source.properties : {},
        effects: source.effects && typeof source.effects === 'object' ? source.effects : {},
    };
}

function buildLegacyInventoryRepairPlan(reportInput) {
    const report = reportInput && typeof reportInput === 'object' ? reportInput : {};
    const items = Array.isArray(report.items) ? report.items : [];
    const fragments = Array.isArray(report.fragmentPairs) ? report.fragmentPairs : [];
    const repeatedGroups = Array.isArray(report.repeatedGroups) ? report.repeatedGroups : [];
    const readyForManualApproval = [];
    const manualReview = [];
    const coveredIds = new Set();

    for (const pair of fragments) {
        const ids = Array.isArray(pair.inventoryItemIds) ? pair.inventoryItemIds.map(Number) : [];
        ids.forEach((id) => coveredIds.add(id));
        readyForManualApproval.push({
            operation: 'inventory.legacy.merge_fragments.propose',
            confidence: pair.confidence || 'high',
            inventoryItemIds: ids,
            keepInventoryItemId: Number(pair.keepInventoryItemId),
            removeInventoryItemId: Number(pair.removeInventoryItemId),
            proposedItemName: cleanText(pair.proposedItemName),
            proposedDescription: cleanText(pair.proposedDescription),
            evidence: {
                reason: pair.reason,
                source: pair.source || null,
                relatedId: pair.relatedId || null,
                playerKey: pair.playerKey || null,
            },
            requiresManualApproval: true,
        });
    }

    for (const group of repeatedGroups) {
        const ids = Array.isArray(group.inventoryItemIds) ? group.inventoryItemIds.map(Number) : [];
        if (
            group.generic
            || !group.standaloneSpecification
            || Number(group.count || 0) < 2
            || ids.some((id) => coveredIds.has(id))
        ) continue;
        ids.forEach((id) => coveredIds.add(id));
        readyForManualApproval.push({
            operation: 'inventory.template.create_and_link.propose',
            confidence: 'high',
            inventoryItemIds: ids,
            proposedTemplate: proposedTemplateFromSource(group),
            evidence: {
                identicalRecords: Number(group.count || ids.length),
                playerKeys: Array.isArray(group.playerKeys) ? group.playerKeys : [],
                reason: 'Registros idênticos possuem definição suficiente para um modelo próprio, sem inferir novas regras.',
            },
            requiresManualApproval: true,
        });
    }

    for (const item of items) {
        if (coveredIds.has(Number(item.id))) continue;
        const high = Array.isArray(item.candidates)
            ? item.candidates.filter((candidate) => candidate.confidence === 'high')
            : [];
        if (item.classification === 'existing_template_high' && high.length === 1) {
            readyForManualApproval.push({
                operation: 'inventory.template.link.propose',
                confidence: 'high',
                inventoryItemIds: [Number(item.id)],
                proposedTemplateKey: high[0].templateKey,
                evidence: high[0],
                requiresManualApproval: true,
            });
            coveredIds.add(Number(item.id));
            continue;
        }
        if (item.classification === 'standalone_model_candidate') {
            readyForManualApproval.push({
                operation: 'inventory.template.create_and_link.propose',
                confidence: 'high',
                inventoryItemIds: [Number(item.id)],
                proposedTemplate: proposedTemplateFromSource(item),
                evidence: {
                    reason: 'O registro possui nome, descrição, categoria e tipo suficientes para um modelo próprio; nenhum modelo parecido será reutilizado.',
                    playerKey: item.playerKey || null,
                    source: item.source || null,
                    relatedId: item.relatedId || null,
                    rejectedSimilarTemplates: Array.isArray(item.candidates) ? item.candidates : [],
                },
                requiresManualApproval: true,
            });
            coveredIds.add(Number(item.id));
            continue;
        }
        manualReview.push({
            inventoryItemId: Number(item.id),
            itemName: cleanText(item.itemName),
            classification: item.classification || 'manual_review',
            reason: item.generic
                ? 'Nome genérico não define qual entidade ou regra deve ser criada.'
                : item.classification === 'existing_template_review'
                    ? 'Existe correspondência possível, mas descrição, categoria, tipo ou regra não são idênticos.'
                    : 'Nenhuma correção automática segura foi comprovada.',
            candidates: Array.isArray(item.candidates) ? item.candidates : [],
            playerKey: item.playerKey || null,
            source: item.source || null,
            relatedId: item.relatedId || null,
        });
    }

    return {
        generatedAt: new Date().toISOString(),
        mode: 'dry-run',
        writesPerformed: false,
        summary: {
            legacyInventoryItemsReviewed: items.length,
            readyForManualApproval: readyForManualApproval.length,
            manualReview: manualReview.length,
            coveredInventoryItems: coveredIds.size,
        },
        readyForManualApproval,
        manualReview,
    };
}

module.exports = {
    buildLegacyInventoryRepairPlan,
    cleanText,
    proposedTemplateFromSource,
};
