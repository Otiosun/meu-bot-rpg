'use strict';

const catalog = require('../../data/traits/canonical-system-traits-v1.json');

function cleanText(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).trim();
    if (!text || ['-', '—', '–', 'null', 'undefined'].includes(text.toLowerCase())) return null;
    return text;
}

function normalizeTraitName(value) {
    const text = cleanText(value);
    if (!text) return '';
    return text
        .replace(/α/g, 'a')
        .replace(/ᥱ/g, 'e')
        .replace(/ı/g, 'i')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function buildCanonicalIndex(traits = catalog.traits) {
    const byName = new Map();
    for (const trait of traits || []) {
        const key = normalizeTraitName(trait?.name);
        if (!key) continue;
        const current = byName.get(key) || [];
        current.push(trait);
        byName.set(key, current);
    }
    return byName;
}

function catalogIntegrity(traits = catalog.traits) {
    const index = buildCanonicalIndex(traits);
    const duplicates = [...index.entries()]
        .filter(([, items]) => items.length > 1)
        .map(([key, items]) => ({ key, names: items.map((item) => item.name) }));
    const invalid = (traits || [])
        .filter((trait) => !normalizeTraitName(trait?.name) || !cleanText(trait?.description))
        .map((trait) => trait?.name || null);
    return {
        version: Number(catalog.version || 1),
        source: catalog.source || null,
        total: Array.isArray(traits) ? traits.length : 0,
        uniqueNames: index.size,
        duplicates,
        invalid,
        ok: duplicates.length === 0 && invalid.length === 0,
    };
}

function templateSnapshot(template) {
    return {
        id: template.id,
        name: template.name,
        slotKey: template.slot_key ?? template.slotKey ?? null,
        description: cleanText(template.description),
        effectText: cleanText(template.effect_text ?? template.effectText),
        restrictionsText: cleanText(template.restrictions_text ?? template.restrictionsText),
        status: template.status ?? null,
        canonicalKey: template.canonical_key ?? template.canonicalKey ?? null,
        traitKind: template.trait_kind ?? template.traitKind ?? null,
        source: template.source ?? null,
    };
}

function buildCanonicalTraitDescriptionPlan(templates, options = {}) {
    const traits = options.traits || catalog.traits;
    const index = buildCanonicalIndex(traits);
    const onlyMissing = options.onlyMissing !== false;
    const actions = [];
    const alreadyDescribed = [];
    const unmatched = [];
    const ambiguous = [];

    for (const rawTemplate of templates || []) {
        const template = templateSnapshot(rawTemplate);
        const key = normalizeTraitName(template.name);
        const candidates = index.get(key) || [];

        // A descrição existente sempre vence. Isso vale inclusive para
        // Traços personalizados que não pertencem ao catálogo do sistema.
        if (onlyMissing && template.description) {
            alreadyDescribed.push({
                template,
                canonicalName: candidates.length === 1 ? candidates[0].name : null,
                canonicalMatch: candidates.length === 1
                    ? 'exact_normalized_name'
                    : candidates.length > 1
                        ? 'ambiguous'
                        : 'none',
                reason: 'description_already_present',
            });
            continue;
        }

        if (!key || candidates.length === 0) {
            unmatched.push({
                template,
                reason: !key ? 'missing_template_name' : 'no_exact_canonical_name',
            });
            continue;
        }

        if (candidates.length > 1) {
            ambiguous.push({
                template,
                reason: 'multiple_exact_canonical_names',
                candidates: candidates.map((item) => item.name),
            });
            continue;
        }

        const canonical = candidates[0];
        actions.push({
            templateId: template.id,
            matchMethod: 'exact_normalized_name',
            namePreserved: true,
            before: template,
            after: {
                name: template.name,
                description: canonical.description,
                effectText: canonical.effectText || null,
                restrictionsText: canonical.restrictionsText || null,
            },
            canonical: {
                name: canonical.name,
                category: canonical.category,
                capacity: canonical.capacity || null,
                sourceTitle: catalog.source?.title || null,
                sourceFileId: catalog.source?.driveFileId || null,
                sourceModifiedAt: catalog.source?.modifiedAt || null,
            },
        });
    }

    return {
        generatedAt: new Date().toISOString(),
        mode: 'readonly_plan',
        policy: {
            exactNameOnly: true,
            changesNames: false,
            appliesWrites: false,
            onlyMissing,
        },
        catalog: catalogIntegrity(traits),
        summary: {
            templatesRead: Array.isArray(templates) ? templates.length : 0,
            plannedUpdates: actions.length,
            alreadyDescribed: alreadyDescribed.length,
            unmatched: unmatched.length,
            ambiguous: ambiguous.length,
        },
        actions,
        alreadyDescribed,
        unmatched,
        ambiguous,
    };
}

module.exports = {
    CANONICAL_TRAIT_CATALOG: catalog,
    buildCanonicalIndex,
    buildCanonicalTraitDescriptionPlan,
    catalogIntegrity,
    cleanText,
    normalizeTraitName,
    templateSnapshot,
};
