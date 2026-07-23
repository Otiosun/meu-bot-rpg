'use strict';

const {
    AUDIENCES,
    PRESENTATION_SCHEMA_VERSION,
    cleanText,
    isAbsenceText,
    normalizedKey,
    record,
    repairDisplayText,
} = require('./characterPresentationCore');
const {
    presentIdentity,
    presentNarrative,
} = require('./characterPresentationNarrative');
const {
    presentCapabilities,
    presentProgression,
} = require('./characterPresentationProgression');
const { presentModifiers } = require('./characterPresentationModifiers');

const PRESENTATION_COMPARISON_VERSION = 'character-presentation-comparison.v1';

function withCapacitySummary(capacityInput, summaryInput) {
    const capacity = record(capacityInput);
    const summary = record(summaryInput);
    if (!Object.keys(capacity).length || capacity.ok === false) return capacity;
    if (Object.keys(record(capacity.summary)).length) return capacity;
    return {
        ...capacity,
        summary: {
            geral: cleanText(summary.summary ?? summary.geral ?? summary.resumo),
            criacao: cleanText(summary.creation ?? summary.criacao),
            reforco: cleanText(summary.reinforcement ?? summary.reforco),
            mana: cleanText(summary.mana),
            fisico: cleanText(summary.physical ?? summary.fisico),
            suporte: cleanText(summary.support ?? summary.suporte ?? record(capacity.support).warning),
        },
    };
}

function buildCharacterPresentation(sources = {}, options = {}) {
    const audience = AUDIENCES.has(options.audience) ? options.audience : 'player';
    const player = record(sources.player);
    const bonus = record(sources.bonus);
    const capacity = record(sources.capacity);
    const traits = record(sources.traits);

    const presentation = {
        schemaVersion: PRESENTATION_SCHEMA_VERSION,
        audience,
        generatedAt: options.generatedAt || new Date().toISOString(),
        identity: presentIdentity(player, bonus),
        narrative: presentNarrative(traits, bonus),
        progression: presentProgression(capacity, bonus),
        capabilities: presentCapabilities(capacity),
        modifiers: presentModifiers(bonus, traits),
    };

    if (audience === 'admin') {
        presentation.audit = {
            sources: {
                player: Boolean(Object.keys(player).length),
                bonus: Boolean(Object.keys(bonus).length),
                capacity: Boolean(Object.keys(capacity).length),
                traits: Boolean(Object.keys(traits).length),
            },
            missingDescriptions: [
                ...presentation.narrative.fixedTraits,
                ...presentation.narrative.extraTraits,
                ...presentation.narrative.extraAnomalies,
            ].filter((trait) => !trait.hasDescription).map((trait) => trait.name),
        };
        if (options.includeTechnical === true) {
            presentation.technical = { player, bonus, capacity, traits };
        }
    }

    return presentation;
}

function array(value) {
    return Array.isArray(value) ? value : [];
}

function numberOrNull(...values) {
    for (const value of values) {
        const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
        if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function sourceFamilyName(player, bonus) {
    const family = record(bonus.family ?? bonus.familia);
    const value = cleanText(family.label ?? family.name ?? family.nome)
        || cleanText(player.familia ?? player.family);
    return value && !isAbsenceText(value, 'family') ? value : null;
}

function sourceTraitNames(traits) {
    return array(traits.slots)
        .map((slot) => cleanText(record(slot).value ?? record(slot).trait?.name))
        .filter((value) => value && !isAbsenceText(value, 'trait'));
}

function normalizedSet(values) {
    return [...new Set(array(values).map(normalizedKey).filter(Boolean))].sort();
}

function sameNormalizedValues(left, right) {
    return JSON.stringify(normalizedSet(left)) === JSON.stringify(normalizedSet(right));
}

function containsSystemNotice(value) {
    const key = normalizedKey(value);
    return key.includes('nao entram automaticamente nos numeros')
        || key.includes('entram automaticamente no custo')
        || key.includes('nao representa mana gasta');
}

function buildCharacterPresentationComparison(sources = {}, presentationInput = {}) {
    const player = record(sources.player);
    const bonus = record(sources.bonus);
    const capacity = record(sources.capacity);
    const traits = record(sources.traits);
    const presentation = record(presentationInput);
    const identity = record(presentation.identity);
    const family = record(identity.family);
    const progression = record(presentation.progression);
    const narrative = record(presentation.narrative);
    const sourceName = cleanText(
        player.personagem_nome
        ?? player.nome
        ?? player.display_name
        ?? record(bonus.identity).name
    );
    const sourceStage = cleanText(capacity.stageName ?? capacity.stage_name ?? capacity.estagio);
    const sourceMana = numberOrNull(
        record(bonus.mana).total,
        bonus.manaTotal,
        capacity.manaTotal,
        capacity.mana_total
    );
    const presentedMana = numberOrNull(record(progression.mana).total);
    const presentedFixedTraits = array(narrative.fixedTraits).map((item) => cleanText(record(item).name)).filter(Boolean);
    const conditionalEntries = [
        ...array(bonus.notAutomatic),
        ...array(bonus.nao_automaticos),
    ];
    const expectedFamily = sourceFamilyName(player, bonus);
    const presentedFamily = cleanText(family.name);

    return {
        version: PRESENTATION_COMPARISON_VERSION,
        readOnly: true,
        legacyEndpoint: '/character',
        previewEndpoint: '/character/presentation-preview',
        aligned: {
            identityName: Boolean(sourceName && identity.name)
                && normalizedKey(sourceName) === normalizedKey(identity.name),
            familyName: expectedFamily === null
                ? presentedFamily === null
                : normalizedKey(expectedFamily) === normalizedKey(presentedFamily),
            stage: sourceStage === null
                ? progression.stage === null
                : normalizedKey(sourceStage) === normalizedKey(progression.stage),
            manaTotal: sourceMana === null ? presentedMana === null : sourceMana === presentedMana,
            fixedTraits: sameNormalizedValues(sourceTraitNames(traits), presentedFixedTraits),
        },
        sourceRisks: {
            structuredFamilyObject: Object.keys(record(bonus.family ?? bonus.familia)).length > 0,
            technicalCapacityEmbedded: Object.keys(capacity).length > 0,
            mixedSystemNotices: conditionalEntries.some(containsSystemNotice),
        },
        counts: {
            fixedTraits: presentedFixedTraits.length,
            extraTraits: array(narrative.extraTraits).length,
            extraAnomalies: array(narrative.extraAnomalies).length,
            hooks: array(narrative.hooks).length,
            automaticModifiers: array(record(presentation.modifiers).automatic).length,
            conditionalModifiers: array(record(presentation.modifiers).conditional).length,
            recurringModifiers: array(record(presentation.modifiers).recurring).length,
            narrativeModifiers: array(record(presentation.modifiers).narrative).length,
            penalties: array(record(presentation.modifiers).penalties).length,
            discounts: array(record(presentation.modifiers).discounts).length,
            notices: array(record(presentation.modifiers).notices).length,
        },
    };
}

function resolveReaders(options = {}) {
    const readers = record(options.readers);
    const bonusReader = readers.getCharacterBonusSummary
        || require('./characterBonusService').getCharacterBonusSummary;
    const capacityModule = readers.getPlayerTechnicalCapacity && readers.buildProfileCapacitySummary
        ? readers
        : require('./capacityService');
    return {
        bonusReader,
        capacityReader: readers.getPlayerTechnicalCapacity
            || capacityModule.getPlayerTechnicalCapacity,
        capacitySummaryReader: readers.buildProfileCapacitySummary
            || capacityModule.buildProfileCapacitySummary,
        traitsReader: readers.getAdminPlayerTraitOverview
            || require('./adminPlayerTraitOverviewService').getAdminPlayerTraitOverview,
    };
}

async function loadCharacterPresentationSources(db, playerId, options = {}) {
    if (!db?.get) throw new TypeError('Banco inválido.');
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    if (!player) {
        const error = new Error('Jogador não encontrado.');
        error.code = 'player_not_found';
        error.status = 404;
        throw error;
    }

    const {
        bonusReader,
        capacityReader,
        capacitySummaryReader,
        traitsReader,
    } = resolveReaders(options);
    const [bonusResult, capacityResult, traitsResult] = await Promise.allSettled([
        bonusReader(db, playerId),
        capacityReader(db, playerId),
        traitsReader(db, playerId),
    ]);
    const sourceIssues = [];
    const audience = AUDIENCES.has(options.audience) ? options.audience : 'player';
    const unwrap = (result, source) => {
        if (result.status === 'fulfilled') return result.value;
        sourceIssues.push({
            source,
            code: audience === 'admin'
                ? (cleanText(result.reason?.code) || 'source_unavailable')
                : 'source_unavailable',
            message: audience === 'admin'
                ? (cleanText(result.reason?.message) || 'Fonte indisponível.')
                : 'Uma parte da ficha não pôde ser carregada.',
        });
        return {};
    };

    const rawCapacity = unwrap(capacityResult, 'capacity');
    let capacitySummary = {};
    if (Object.keys(record(rawCapacity)).length && typeof capacitySummaryReader === 'function') {
        try {
            capacitySummary = capacitySummaryReader(rawCapacity);
        } catch {
            sourceIssues.push({
                source: 'capacity_summary',
                code: 'source_unavailable',
                message: audience === 'admin'
                    ? 'A síntese humana de capacidade falhou.'
                    : 'Uma parte da ficha não pôde ser carregada.',
            });
        }
    }

    return {
        sources: {
            player,
            bonus: unwrap(bonusResult, 'bonus'),
            capacity: withCapacitySummary(rawCapacity, capacitySummary),
            traits: unwrap(traitsResult, 'traits'),
        },
        sourceIssues,
    };
}

async function getCharacterPresentation(db, playerId, options = {}) {
    const loaded = await loadCharacterPresentationSources(db, playerId, options);
    const presentation = buildCharacterPresentation(loaded.sources, options);
    if (loaded.sourceIssues.length) presentation.partialIssues = loaded.sourceIssues;
    return presentation;
}

async function getCharacterPresentationPreview(db, playerId, options = {}) {
    const safeOptions = {
        ...options,
        audience: 'player',
        includeTechnical: false,
    };
    const loaded = await loadCharacterPresentationSources(db, playerId, safeOptions);
    const presentation = buildCharacterPresentation(loaded.sources, safeOptions);
    if (loaded.sourceIssues.length) presentation.partialIssues = loaded.sourceIssues;
    return {
        presentation,
        comparison: buildCharacterPresentationComparison(loaded.sources, presentation),
    };
}

module.exports = {
    AUDIENCES,
    PRESENTATION_COMPARISON_VERSION,
    PRESENTATION_SCHEMA_VERSION,
    buildCharacterPresentation,
    buildCharacterPresentationComparison,
    cleanText,
    getCharacterPresentation,
    getCharacterPresentationPreview,
    loadCharacterPresentationSources,
    normalizedKey,
    presentCapabilities,
    presentIdentity,
    presentModifiers,
    presentNarrative,
    presentProgression,
    repairDisplayText,
    withCapacitySummary,
};