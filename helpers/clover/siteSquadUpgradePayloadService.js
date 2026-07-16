'use strict';

const {
    ACCESS_PERMISSIONS,
    authorizeSquadAccess,
} = require('./accessIntegrationService');
const {
    getSquadUpgrade,
} = require('./squadUpgradeCatalog');
const {
    getSquadUpgradeState,
} = require('./squadUpgradeService');
const { resolveSquad } = require('./squadStateService');

function activationLabel(item) {
    if (item.requiresApproval) return 'Exige aprovação em uso relevante';
    if (item.activation === 'weekly_review') return 'Uso contextual com controle semanal';
    if (item.activation === 'passive_narrative') return 'Passiva narrativa';
    return 'Uso contextual em cena';
}

function blockedReasonLabels(item) {
    const labels = [];
    if (item.owned) labels.push('Já adquirida');
    if (item.blockedCodes.includes('grade')) labels.push(`Exige Grau ${item.requiredGrade}`);
    if (item.blockedCodes.includes('prerequisite')) labels.push('Pré-requisito ausente');
    if (item.blockedCodes.includes('stars')) labels.push('Estrelas Atuais insuficientes');
    return labels;
}

function prerequisiteNames(item) {
    return item.prerequisites.map((key) => getSquadUpgrade(key)?.name || key);
}

function missingPrerequisiteNames(item) {
    return item.missingPrerequisites.map((key) => getSquadUpgrade(key)?.name || key);
}

function serializeUpgrade(item) {
    return {
        id: item.id,
        key: item.key,
        name: item.name,
        categoryKey: item.categoryKey,
        categoryLabel: item.categoryLabel,
        cost: Number(item.cost || 0),
        requiredGrade: Number(item.requiredGrade || 0),
        requiredHistoricalStars: Number(item.requiredHistoricalStars || 0),
        prerequisites: prerequisiteNames(item),
        missingPrerequisites: missingPrerequisiteNames(item),
        effect: item.effect,
        activation: activationLabel(item),
        requiresApproval: Boolean(item.requiresApproval),
        owned: Boolean(item.owned),
        available: Boolean(item.available),
        blockedReasons: blockedReasonLabels(item),
    };
}

function serializeCategory(category, items) {
    return {
        key: category.key,
        label: category.label,
        symbol: category.symbol,
        total: Number(category.total || 0),
        owned: Number(category.owned || 0),
        available: Number(category.available || 0),
        items: items.filter((item) => item.categoryKey === category.key).map(serializeUpgrade),
    };
}

async function getSiteSquadUpgradeCatalog(db, {
    actorId,
    squadInput,
}) {
    const squad = typeof squadInput === 'object' && squadInput?.squad_key
        ? squadInput
        : await resolveSquad(db, { squadName: squadInput });
    if (!squad) return { ok: false, code: 'squad_not_found' };

    const access = await authorizeSquadAccess(db, {
        actorId,
        squad,
        permission: ACCESS_PERMISSIONS.SQUAD_RESOURCES_READ,
        allowMemberRead: true,
    });
    if (!access.ok) {
        return {
            ok: false,
            code: 'forbidden',
            squadKey: squad.squad_key,
        };
    }

    const state = await getSquadUpgradeState(db, squad);
    if (!state.ok) return state;
    const categories = state.categories.map((category) => serializeCategory(category, state.items));

    return {
        ok: true,
        access: access.code,
        squad: {
            key: state.squadKey,
            name: state.squad.name,
        },
        currentStars: Number(state.currentStars || 0),
        historicalStars: Number(state.historicalStars || 0),
        renownGrade: Number(state.renownGrade || 0),
        ownedCount: Number(state.ownedCount || 0),
        totalCount: Number(state.totalCount || 0),
        categories,
    };
}

module.exports = {
    activationLabel,
    blockedReasonLabels,
    getSiteSquadUpgradeCatalog,
    missingPrerequisiteNames,
    prerequisiteNames,
    serializeCategory,
    serializeUpgrade,
};
