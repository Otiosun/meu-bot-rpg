'use strict';
const { getConfigOption } = require('./configLoader');

function validatePurchasedRollComposition(roll) {
    if (!roll) return [];
    const errors = [];
    const race = getConfigOption('races', roll.race_key);
    const grimoire = getConfigOption('grimoires', roll.grimoire_key);

    if (race && Number(race.weightsByKingdom?.[roll.kingdom_key] || 0) <= 0) {
        errors.push(`A combinação final do roll está inválida: ${roll.race} não é compatível com ${roll.kingdom}. Ajuste Raça ou Reino na Loja de Retorno.`);
    }
    if (grimoire && grimoire.kingdomKey !== roll.kingdom_key) {
        errors.push(`A combinação final do roll está inválida: ${roll.grimoire} não pertence a ${roll.kingdom}. Ajuste Grimório ou Reino na Loja de Retorno.`);
    }
    if (roll.race_key && roll.race_key !== 'humano'
        && roll.social_class_key && roll.social_class_key !== 'nao_se_aplica') {
        errors.push(`A combinação final do roll está inválida: ${roll.race} não usa classe social humana.`);
    }
    return errors;
}

module.exports = { validatePurchasedRollComposition };
