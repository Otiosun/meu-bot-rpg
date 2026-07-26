'use strict';

function cleanText(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).trim();
    return text || null;
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
        if (group.generic || group.count < 3 || ids.some((id) => coveredIds.has(id))) continue;
        ids.forEach((id) => coveredIds.add(id));
        readyForManualApproval.push({
            operation: 'inventory.template.create_and_link.propose',
            confidence: 'high',
            inventoryItemIds: ids,
            proposedTemplate: {
                itemName: cleanText(group.itemName),
                description: cleanText(group.description),
                category: cleanText(group.category),
                kind: cleanText(group.kind),
            },
            evidence: {
                identicalRecords: Number(group.count || ids.length),
                playerKeys: Array.isArray(group.playerKeys) ? group.playerKeys : [],
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
};
