'use strict';

const ALLOWED_RESOLUTION_TYPES = new Set([
    'retype_and_link_existing_template',
    'create_pending_entitlement_template',
    'create_pending_narrative_item_template',
]);

class LegacyEventRewardResolutionError extends Error {
    constructor(code, message, details = null) {
        super(message || code);
        this.name = 'LegacyEventRewardResolutionError';
        this.code = code;
        this.details = details;
    }
}

function cleanText(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
    );
}

function exactJson(left, right) {
    return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function normalizedBoolean(value) {
    return Number(value ?? 0) ? 1 : 0;
}

function itemSnapshot(item) {
    return {
        id: Number(item.id),
        characterName: cleanText(item.characterName ?? item.character_name),
        relatedId: cleanText(item.relatedId ?? item.related_id),
        source: cleanText(item.source),
        templateKey: cleanText(item.templateKey ?? item.template_key),
        itemName: cleanText(item.itemName ?? item.item_name),
        description: cleanText(item.description),
        quantity: Number(item.quantity || 0),
        category: cleanText(item.category),
        kind: cleanText(item.kind),
        origin: cleanText(item.origin),
        status: cleanText(item.status),
        transferable: normalizedBoolean(item.transferable),
        properties: stableValue(item.properties || {}),
        effects: stableValue(item.effects || {}),
    };
}

function templateSnapshot(template) {
    if (!template) return null;
    return {
        templateKey: cleanText(template.templateKey ?? template.template_key),
        itemName: cleanText(template.itemName ?? template.item_name),
        description: cleanText(template.description),
        category: cleanText(template.category),
        kind: cleanText(template.kind),
        origin: cleanText(template.origin) || 'Clover',
        transferable: normalizedBoolean(template.transferable),
        properties: stableValue(template.properties || {}),
        effects: stableValue(template.effects || {}),
    };
}

function resolutionTemplate(resolution) {
    return {
        templateKey: cleanText(resolution.templateKey),
        itemName: cleanText(resolution.itemName),
        description: cleanText(resolution.description),
        category: cleanText(resolution.category),
        kind: cleanText(resolution.kind),
        origin: cleanText(resolution.origin) || 'Clover',
        transferable: resolution.transferable === true ? 1 : 0,
        properties: stableValue(resolution.properties || {}),
        effects: stableValue(resolution.effects || {}),
    };
}

function validateManifest(manifestInput) {
    const manifest = manifestInput && typeof manifestInput === 'object' ? manifestInput : {};
    const decisions = Array.isArray(manifest.decisions) ? manifest.decisions : [];
    if (manifest.version !== 1 || decisions.length !== 8) {
        throw new LegacyEventRewardResolutionError(
            'invalid_manifest_shape',
            'O manifesto precisa possuir versão 1 e exatamente oito decisões.',
            { version: manifest.version, decisions: decisions.length }
        );
    }
    if (cleanText(manifest.source?.documentId) !== '1UpAJzwlpMC6e95Vu0NErV-g6znanYu8tA4YG1wOY6n0') {
        throw new LegacyEventRewardResolutionError(
            'unexpected_source_document',
            'O manifesto não aponta para o documento oficial auditado.'
        );
    }

    const relatedIds = new Set();
    const templateDefinitions = new Map();
    for (const [index, decision] of decisions.entries()) {
        const relatedId = cleanText(decision.relatedId);
        if (!relatedId || relatedIds.has(relatedId)) {
            throw new LegacyEventRewardResolutionError(
                'duplicate_or_missing_related_id',
                'A decisão possui relatedId ausente ou repetido.',
                { index, relatedId }
            );
        }
        relatedIds.add(relatedId);

        const expected = decision.expected || {};
        for (const field of [
            'characterName', 'itemName', 'description', 'quantity',
            'category', 'kind', 'source',
        ]) {
            if (expected[field] === null || expected[field] === undefined || expected[field] === '') {
                throw new LegacyEventRewardResolutionError(
                    'incomplete_expected_snapshot',
                    `Campo esperado ausente: ${field}`,
                    { index, relatedId }
                );
            }
        }

        const resolution = decision.resolution || {};
        if (!ALLOWED_RESOLUTION_TYPES.has(resolution.type)) {
            throw new LegacyEventRewardResolutionError(
                'unsupported_resolution_type',
                'Tipo de resolução não suportado.',
                { index, relatedId, type: resolution.type }
            );
        }
        const templateKey = cleanText(resolution.templateKey);
        if (!templateKey) {
            throw new LegacyEventRewardResolutionError(
                'missing_resolution_template',
                'A resolução não informa o modelo de destino.',
                { index, relatedId }
            );
        }

        if (resolution.type === 'retype_and_link_existing_template') {
            if (templateKey !== 'acesso_dungeon_exclusiva' || resolution.preserveQuantity !== true) {
                throw new LegacyEventRewardResolutionError(
                    'unsafe_existing_template_resolution',
                    'O acesso legado deve apontar ao Passe da Dungeon e preservar a quantidade.',
                    { index, relatedId, templateKey }
                );
            }
            continue;
        }

        const proposed = resolutionTemplate(resolution);
        for (const field of ['itemName', 'description', 'category', 'kind']) {
            if (!proposed[field]) {
                throw new LegacyEventRewardResolutionError(
                    'incomplete_pending_template',
                    `Modelo pendente sem ${field}.`,
                    { index, relatedId, templateKey }
                );
            }
        }
        if (proposed.effects && Object.keys(proposed.effects).length > 0) {
            throw new LegacyEventRewardResolutionError(
                'invented_pending_effect',
                'Recompensa pendente não pode receber efeito automático.',
                { index, relatedId, templateKey }
            );
        }
        if (proposed.properties?.specificationStatus !== 'pending'
            || proposed.properties?.automaticEffect !== false
            || proposed.properties?.legacyReward !== true) {
            throw new LegacyEventRewardResolutionError(
                'unsafe_pending_properties',
                'Modelo pendente precisa declarar pendência e ausência de efeito automático.',
                { index, relatedId, templateKey }
            );
        }
        if (templateDefinitions.has(templateKey)
            && !exactJson(templateDefinitions.get(templateKey), proposed)) {
            throw new LegacyEventRewardResolutionError(
                'conflicting_template_definition',
                'Duas decisões definem modelos diferentes com a mesma chave.',
                { index, relatedId, templateKey }
            );
        }
        templateDefinitions.set(templateKey, proposed);
    }

    return { ...manifest, decisions };
}

function expectedSnapshot(decision) {
    return {
        characterName: cleanText(decision.expected.characterName),
        relatedId: cleanText(decision.relatedId),
        source: cleanText(decision.expected.source),
        templateKey: null,
        itemName: cleanText(decision.expected.itemName),
        description: cleanText(decision.expected.description),
        quantity: Number(decision.expected.quantity),
        category: cleanText(decision.expected.category),
        kind: cleanText(decision.expected.kind),
    };
}

function assertCurrentItem(item, decision) {
    const actual = itemSnapshot(item);
    const expected = expectedSnapshot(decision);
    const comparableActual = {
        characterName: actual.characterName,
        relatedId: actual.relatedId,
        source: actual.source,
        templateKey: actual.templateKey,
        itemName: actual.itemName,
        description: actual.description,
        quantity: actual.quantity,
        category: actual.category,
        kind: actual.kind,
    };
    if (!exactJson(comparableActual, expected)) {
        throw new LegacyEventRewardResolutionError(
            'stale_legacy_reward',
            'O registro legado divergiu da evidência usada na decisão.',
            { relatedId: decision.relatedId, actual: comparableActual, expected }
        );
    }
    return actual;
}

function buildResolutionPlan(manifestInput, inventoryItemsInput, templatesInput) {
    const manifest = validateManifest(manifestInput);
    const items = Array.isArray(inventoryItemsInput) ? inventoryItemsInput : [];
    const templates = Array.isArray(templatesInput) ? templatesInput : [];
    const byRelatedId = new Map();
    for (const item of items) {
        const key = cleanText(item.relatedId ?? item.related_id);
        if (!key) continue;
        if (byRelatedId.has(key)) {
            throw new LegacyEventRewardResolutionError(
                'duplicate_inventory_related_id',
                'Mais de um registro do inventário usa o mesmo relatedId.',
                { relatedId: key }
            );
        }
        byRelatedId.set(key, item);
    }
    const byTemplateKey = new Map(
        templates.map((template) => [
            cleanText(template.templateKey ?? template.template_key),
            template,
        ])
    );

    const actions = [];
    const templatesToCreate = new Map();
    for (const decision of manifest.decisions) {
        const item = byRelatedId.get(decision.relatedId);
        if (!item) {
            throw new LegacyEventRewardResolutionError(
                'legacy_reward_not_found',
                'Recompensa legada esperada não foi encontrada.',
                { relatedId: decision.relatedId }
            );
        }
        const before = assertCurrentItem(item, decision);
        const resolution = decision.resolution;
        let destination;
        let createsTemplate = false;

        if (resolution.type === 'retype_and_link_existing_template') {
            const existing = byTemplateKey.get(resolution.templateKey);
            if (!existing) {
                throw new LegacyEventRewardResolutionError(
                    'destination_template_not_found',
                    'Modelo existente de destino não foi encontrado.',
                    { relatedId: decision.relatedId, templateKey: resolution.templateKey }
                );
            }
            destination = templateSnapshot(existing);
        } else {
            destination = resolutionTemplate(resolution);
            const existing = byTemplateKey.get(destination.templateKey);
            if (existing) {
                const actualTemplate = templateSnapshot(existing);
                if (!exactJson(actualTemplate, destination)) {
                    throw new LegacyEventRewardResolutionError(
                        'destination_template_conflict',
                        'Já existe um modelo diferente com a chave proposta.',
                        { relatedId: decision.relatedId, templateKey: destination.templateKey }
                    );
                }
            } else {
                createsTemplate = true;
                templatesToCreate.set(destination.templateKey, destination);
            }
        }

        actions.push({
            inventoryItemId: before.id,
            relatedId: decision.relatedId,
            resolutionType: resolution.type,
            createsTemplate,
            before,
            after: {
                ...before,
                templateKey: destination.templateKey,
                itemName: destination.itemName,
                description: destination.description,
                category: destination.category,
                kind: destination.kind,
                origin: destination.origin,
                transferable: destination.transferable,
                properties: destination.properties,
                effects: destination.effects,
            },
            evidence: {
                sourceDocumentId: manifest.source.documentId,
                sourceDocumentTitle: manifest.source.title,
                automaticEffectDefined: false,
            },
        });
    }

    const decided = new Set(manifest.decisions.map((entry) => entry.relatedId));
    const unresolvedLegacyItems = items
        .map(itemSnapshot)
        .filter((item) => !item.templateKey && !decided.has(item.relatedId));
    const dungeonActions = actions.filter(
        (action) => action.resolutionType === 'retype_and_link_existing_template'
    );
    const pendingActions = actions.filter(
        (action) => action.resolutionType !== 'retype_and_link_existing_template'
    );

    return {
        generatedAt: new Date().toISOString(),
        mode: 'readonly_plan',
        writesPerformed: false,
        source: manifest.source,
        policy: {
            exactRelatedIdOnly: true,
            deletesInventoryItems: false,
            preservesQuantities: true,
            automaticEffects: false,
            convertsSpellRewardToTicket: false,
        },
        summary: {
            decisions: actions.length,
            inventoryRowsCovered: actions.length,
            inventoryUnitsCovered: actions.reduce((sum, action) => sum + action.before.quantity, 0),
            dungeonAccessRows: dungeonActions.length,
            dungeonAccessUnits: dungeonActions.reduce((sum, action) => sum + action.before.quantity, 0),
            pendingDefinitionRows: pendingActions.length,
            templatesToCreate: templatesToCreate.size,
            unresolvedLegacyItems: unresolvedLegacyItems.length,
        },
        templatesToCreate: [...templatesToCreate.values()],
        actions,
        unresolvedLegacyItems,
    };
}

module.exports = {
    ALLOWED_RESOLUTION_TYPES,
    LegacyEventRewardResolutionError,
    buildResolutionPlan,
    cleanText,
    itemSnapshot,
    templateSnapshot,
    validateManifest,
};
