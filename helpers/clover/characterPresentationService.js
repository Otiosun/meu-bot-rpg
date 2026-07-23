'use strict';

const {
    AUDIENCES,
    PRESENTATION_SCHEMA_VERSION,
    cleanText,
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

async function getCharacterPresentation(db, playerId, options = {}) {
    if (!db?.get) throw new TypeError('Banco inválido.');
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    if (!player) {
        const error = new Error('Jogador não encontrado.');
        error.code = 'player_not_found';
        error.status = 404;
        throw error;
    }

    const readers = record(options.readers);
    const bonusReader = readers.getCharacterBonusSummary
        || require('./characterBonusService').getCharacterBonusSummary;
    const capacityModule = readers.getPlayerTechnicalCapacity && readers.buildProfileCapacitySummary
        ? readers
        : require('./capacityService');
    const capacityReader = readers.getPlayerTechnicalCapacity
        || capacityModule.getPlayerTechnicalCapacity;
    const capacitySummaryReader = readers.buildProfileCapacitySummary
        || capacityModule.buildProfileCapacitySummary;
    const traitsReader = readers.getAdminPlayerTraitOverview
        || require('./adminPlayerTraitOverviewService').getAdminPlayerTraitOverview;

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

    const presentation = buildCharacterPresentation({
        player,
        bonus: unwrap(bonusResult, 'bonus'),
        capacity: withCapacitySummary(rawCapacity, capacitySummary),
        traits: unwrap(traitsResult, 'traits'),
    }, options);

    if (sourceIssues.length) presentation.partialIssues = sourceIssues;
    return presentation;
}

module.exports = {
    AUDIENCES,
    PRESENTATION_SCHEMA_VERSION,
    buildCharacterPresentation,
    cleanText,
    getCharacterPresentation,
    normalizedKey,
    presentCapabilities,
    presentIdentity,
    presentModifiers,
    presentNarrative,
    presentProgression,
    repairDisplayText,
    withCapacitySummary,
};
