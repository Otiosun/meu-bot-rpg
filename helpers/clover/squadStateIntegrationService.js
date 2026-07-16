'use strict';

const {
    buildOverallReading,
    getSquadState,
} = require('./squadStateService');
const { getSquadUpgradeState } = require('./squadUpgradeService');

function buildIntegratedStructure(upgrades) {
    if (!upgrades?.ok) return null;
    const activeRows = upgrades.activeRows || [];
    const activeCategories = upgrades.categories
        .filter((category) => category.owned > 0)
        .map((category) => ({
            key: category.key,
            label: category.label,
            count: category.owned,
        }));
    const names = activeRows.map((row) => row.upgrade_name).filter(Boolean);
    const count = activeRows.length;
    const sectorCount = activeCategories.length;

    return {
        registered: true,
        count,
        sectorCount,
        categories: activeCategories,
        upgrades: names,
        label: count ? `${count} benfeitoria(s) ativa(s)` : 'Sem benfeitorias',
        description: count
            ? `${count} benfeitoria(s) ativa(s) distribuída(s) em ${sectorCount} setor(es): ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` e mais ${names.length - 4}` : ''}.`
            : 'O QG está registrado, mas ainda não possui benfeitorias ativas.',
    };
}

async function getIntegratedSquadState(db, squadInput) {
    const state = await getSquadState(db, squadInput);
    if (!state.ok) return state;

    const upgrades = await getSquadUpgradeState(db, state.squad);
    const structure = buildIntegratedStructure(upgrades);
    if (structure) {
        state.structure = structure;
        state.overallReading = buildOverallReading(state);
    }
    state.upgradeState = upgrades;
    return state;
}

module.exports = {
    buildIntegratedStructure,
    getIntegratedSquadState,
};
