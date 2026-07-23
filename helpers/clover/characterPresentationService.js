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

    const { getCharacterBonusSummary } = require('./characterBonusService');
    const { getPlayerTechnicalCapacity } = require('./capacityService');
    const { getAdminPlayerTraitOverview } = require('./adminPlayerTraitOverviewService');

    const [bonusResult, capacityResult, traitsResult] = await Promise.allSettled([
        getCharacterBonusSummary(db, playerId),
        getPlayerTechnicalCapacity(db, playerId),
        getAdminPlayerTraitOverview(db, playerId),
    ]);

    const sourceIssues = [];
    const unwrap = (result, source) => {
        if (result.status === 'fulfilled') return result.value;
        sourceIssues.push({
            source,
            code: cleanText(result.reason?.code) || 'source_unavailable',
            message: cleanText(result.reason?.message) || 'Fonte indisponível.',
        });
        return {};
    };

    const presentation = buildCharacterPresentation({
        player,
        bonus: unwrap(bonusResult, 'bonus'),
        capacity: unwrap(capacityResult, 'capacity'),
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
};
