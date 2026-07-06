const { loadCloverConfigs } = require('./configLoader');
const { getClosestTextMatches, normalizeText } = require('../textUtils');

const NO_FAMILY_KEY = 'sem_linhagem';

function normalizeLookup(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function resolveFromList(list, input) {
    const normalizedInput = normalizeLookup(input);
    if (!normalizedInput || normalizedInput === 'nenhuma' || normalizedInput === 'nenhum') return null;

    return list.find((item) => {
        const keyText = normalizeLookup(String(item.key || '').replace(/_/g, ' '));
        return keyText === normalizedInput || normalizeLookup(item.name) === normalizedInput;
    }) || null;
}

function resolveFamily(input) {
    const config = loadCloverConfigs();
    return resolveFromList(config.lists.families, input);
}

function resolveNoFamily() {
    const config = loadCloverConfigs();
    return config.maps.families.get(NO_FAMILY_KEY) || {
        key: NO_FAMILY_KEY,
        name: 'Sem linhagem registrada',
        capacity: null,
    };
}

function resolveRollKingdomKey(roll) {
    if (roll?.kingdom_key) return roll.kingdom_key;

    const config = loadCloverConfigs();
    const kingdom = resolveFromList(config.lists.kingdoms, roll?.kingdom);
    return kingdom?.key || null;
}

function resolveRollSocialClassKey(roll) {
    if (roll?.social_class_key) return roll.social_class_key;

    const config = loadCloverConfigs();
    const socialClass = resolveFromList(config.lists.socialClasses, roll?.social_class);
    return socialClass?.key || null;
}

function resolveRollRaceKey(roll) {
    if (roll?.race_key) return roll.race_key;

    const config = loadCloverConfigs();
    const race = resolveFromList(config.lists.races, roll?.race);
    return race?.key || null;
}

function isFamilyApplicableForRoll(roll) {
    return resolveRollRaceKey(roll) === 'humano';
}

function validateFamilyChoice(familyInput, roll) {
    const applies = isFamilyApplicableForRoll(roll);
    const normalizedInput = normalizeLookup(familyInput);
    const isBlank = !normalizedInput
        || normalizedInput === '-'
        || normalizedInput === 'n a'
        || normalizedInput === 'na'
        || normalizedInput === 'nao se aplica'
        || normalizedInput === 'não se aplica'
        || normalizedInput === 'nenhuma'
        || normalizedInput === 'nenhum'
        || normalizedInput === 'nao'
        || normalizedInput === 'não'
        || normalizedInput === 'sem'
        || normalizedInput === 'sem familia'
        || normalizedInput === 'sem família'
        || normalizedInput === 'sem linhagem'
        || normalizedInput === 'sem linhagem registrada';

    if (isBlank) {
        return {
            ok: true,
            family: resolveNoFamily(),
            errors: [],
            applies: true,
        };
    }

    if (!applies) {
        return {
            ok: false,
            family: null,
            errors: ['Familia nao se aplica para a raca deste roll.'],
            applies: false,
        };
    }

    const family = resolveFamily(familyInput);
    if (!family) {
        const config = loadCloverConfigs();
        const suggestions = getClosestTextMatches(familyInput, config.lists.families);
        return {
            ok: false,
            family: null,
            errors: [`Familia invalida ou nao informada.${suggestions.length ? ` Opcoes proximas: ${suggestions.join(', ')}.` : ''}`],
            applies: true,
        };
    }

    if (family.key === NO_FAMILY_KEY) {
        return {
            ok: true,
            family,
            errors: [],
            applies: true,
        };
    }

    const kingdomKey = resolveRollKingdomKey(roll);
    const socialClassKey = resolveRollSocialClassKey(roll);
    const errors = [];

    if (!kingdomKey || !family.kingdomKeys.includes(kingdomKey)) {
        errors.push('Familia nao compativel com o reino do roll escolhido.');
    }

    if (!socialClassKey || !family.socialClassKeys.includes(socialClassKey)) {
        errors.push('Familia nao compativel com a classe social do roll escolhido.');
    }

    return {
        ok: errors.length === 0,
        family,
        errors,
        applies: true,
    };
}

module.exports = {
    isFamilyApplicableForRoll,
    resolveFamily,
    resolveRollKingdomKey,
    resolveRollRaceKey,
    resolveRollSocialClassKey,
    validateFamilyChoice,
};
