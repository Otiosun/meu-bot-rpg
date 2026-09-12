const { loadCloverConfigs } = require('./configLoader');
const { MAX_PLAYER_ROLLS } = require('../../config/bot');
const { countUsedSlots } = require('./slotManager');

const MAGIC_SCOPE_BY_KINGDOM = {
    clover: 'Misto',
    spade: 'Misto',
    diamond: 'Misto',
    heart: 'Elemental',
};

function rollWeighted(options, weightField = 'chance') {
    const weightedOptions = options
        .map((option) => ({
            ...option,
            weight: Number(option[weightField] ?? option.chance ?? 0),
        }))
        .filter((option) => option.weight > 0);

    if (!weightedOptions.length) {
        throw new Error('Nao ha opcoes com peso valido para sorteio.');
    }

    const total = weightedOptions.reduce((sum, option) => sum + option.weight, 0);
    const random = Math.random() * total;
    let current = 0;

    for (const option of weightedOptions) {
        current += option.weight;
        if (random <= current) return option;
    }

    return weightedOptions[weightedOptions.length - 1];
}

function getRacePool(config, kingdomKey) {
    return config.lists.races
        .map((race) => ({
            ...race,
            chance: Number(race.weightsByKingdom?.[kingdomKey] || 0),
        }))
        .filter((race) => race.chance > 0);
}

function getGrimoirePool(config, kingdomKey) {
    return config.lists.grimoires
        .filter((grimoire) => grimoire.kingdomKey === kingdomKey);
}

function applySacrificeMagicWeights(options) {
    // Pool final realmente buffado: soma 100 e aumenta Epica/Lendaria/Mitica.
    const weights = {
        incomum: 25,
        rara: 30,
        epica: 28,
        lendaria: 15,
        mitica: 2,
    };

    return options.map((option) => ({
        ...option,
        chance: weights[option.key] ?? option.chance,
    }));
}

function applySacrificeRaceWeights(options, kingdomKey) {
    if (kingdomKey !== 'clover') return options;

    const weights = {
        humano: 50,
        bruxa: 25,
        anao: 22,
        elfo: 3,
    };

    return options.map((option) => ({
        ...option,
        chance: weights[option.key] ?? option.chance,
    }));
}

async function filterAvailableSlotOptions(db, category, options) {
    if (!db) return options;

    const available = [];
    for (const option of options) {
        if (option.capacity === null || option.capacity === undefined) {
            available.push(option);
            continue;
        }

        const used = await countUsedSlots(db, category, option.key);
        if (used < option.capacity) available.push(option);
    }

    return available;
}

async function hasAvailableMagicForRarity(db, config, rarityKey) {
    if (!db) return true;

    const normalizedRarity = normalizeRollValue(rarityKey);
    const magicOptions = (config.lists.magics || []).filter((magic) => (
        normalizeRollValue(magic.rarity) === normalizedRarity
    ));

    if (!magicOptions.length) {
        return normalizedRarity === 'comum' || normalizedRarity === 'incomum';
    }

    for (const magic of magicOptions) {
        if (magic.capacity === null || magic.capacity === undefined) return true;

        const used = await countUsedSlots(db, 'magic', magic.key);
        if (used < magic.capacity) return true;
    }

    return false;
}

async function filterAvailableMagicRarities(db, config, options, context = {}) {
    if (!db) return options;

    const available = [];
    for (const option of options) {
        const rarityKey = normalizeRollValue(option.key || option.name);
        if (context.kingdomKey === 'heart' && ['lendaria', 'mitica'].includes(rarityKey)) {
            continue;
        }

        if (await hasAvailableMagicForRarity(db, config, rarityKey)) {
            available.push(option);
        }
    }

    return available;
}

function buildRollSummary(roll) {
    return [
        roll.kingdom,
        roll.socialClass,
        roll.race,
        roll.grimoire,
        roll.magicRarity,
    ].join(' | ');
}

function normalizeRollValue(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function getMagicRarityLevel(roll) {
    const key = normalizeRollValue(roll?.magic_rarity_key || roll?.magicRarityKey);
    const name = normalizeRollValue(roll?.magic_rarity || roll?.magicRarity);
    if (key === 'mitica' || name.includes('mitica')) return 6;
    if (key === 'lendaria' || name.includes('lendaria')) return 5;
    if (key === 'epica' || name.includes('epica')) return 4;
    if (key === 'rara' || name.includes('rara')) return 3;
    if (key === 'incomum' || name.includes('incomum')) return 2;
    return 1;
}

function getGrimoireScore(roll) {
    const key = normalizeRollValue(roll?.grimoire_key || roll?.grimoireKey);
    const rank = normalizeRollValue(roll?.grimoire_rank || roll?.grimoireRank);
    const name = normalizeRollValue(roll?.grimoire || roll?.grimoire);
    if (
        key.includes('demonic')
        || key.includes('broken')
        || rank.includes('demon')
        || name.includes('5 folhas')
        || name.includes('demoniaco')
        || name.includes('demonico')
        || name.includes('coracao partido')
        || name.includes('diamante quebrado')
        || name.includes('costurado')
        || name.includes('3 espadas')
    ) return 7;
    if (key.endsWith('_4f') || rank === '4f' || name.includes('4 folhas') || name.includes('(4f)')) return 5;
    return 0;
}

function getRaceScore(roll) {
    const key = normalizeRollValue(roll?.race_key || roll?.raceKey);
    const name = normalizeRollValue(roll?.race || roll?.race);
    const race = key || name;
    if (race === 'elfo') return 8;
    if (race === 'bruxa' || race === 'anao') return 4;
    return 0;
}

function getSocialClassScore(roll) {
    const key = normalizeRollValue(roll?.social_class_key || roll?.socialClassKey);
    const name = normalizeRollValue(roll?.social_class || roll?.socialClass);
    const socialClass = key || name;
    if (socialClass === 'realeza') return 6;
    if (socialClass === 'nobreza') return 4;
    if (socialClass === 'burguesia') return 2;
    if (socialClass === 'artesao_comerciante' || socialClass.includes('artesao')) return 1;
    return 0;
}

function getRollQualityScore(roll) {
    const magicLevel = getMagicRarityLevel(roll);
    const magicScore = magicLevel >= 5 ? 7 : magicLevel >= 4 ? 4 : magicLevel >= 3 ? 1 : 0;
    return magicScore + getRaceScore(roll) + getSocialClassScore(roll) + getGrimoireScore(roll);
}

function hasGoodRollMarker(roll) {
    return getMagicRarityLevel(roll) >= 4
        || getRaceScore(roll) >= 4
        || getGrimoireScore(roll) >= 5;
}

function getMercyUpgradeChance(previousRolls) {
    if (!previousRolls.length) return 0;
    if (previousRolls.some(hasGoodRollMarker)) return 0;

    const rollIndex = previousRolls.length + 1;
    if (rollIndex >= MAX_PLAYER_ROLLS) return 1;
    if (rollIndex === MAX_PLAYER_ROLLS - 1) return 0.65;
    if (rollIndex === 3) return 0.35;
    if (rollIndex === 2) return 0.18;
    return 0;
}

function findConfigOption(list, key) {
    return (list || []).find((item) => item.key === key) || null;
}

function applyRollOption(roll, type, option) {
    if (type === 'magic_rarity') {
        roll.magicRarity = option.name;
        roll.magicRarityKey = option.key;
    } else if (type === 'social_class') {
        roll.socialClass = option.name;
        roll.socialClassKey = option.key;
    } else if (type === 'race') {
        roll.race = option.name;
        roll.raceKey = option.key;
        roll.socialClass = 'N/A';
        roll.socialClassKey = 'nao_se_aplica';
    } else if (type === 'heart_elemental_focus') {
        roll.elementalFavor = true;
        roll.magicScope = 'Elemental Favorecido';
    }
}

function getMercyUpgradeOptions(config, roll, availableRacePool, availableMagicRarityPool = config.lists.magicRarities, context = {}) {
    const options = [];
    const epicMagic = findConfigOption(availableMagicRarityPool, 'epica');
    const isHeart = roll.kingdomKey === 'heart';

    if (epicMagic && getMagicRarityLevel(roll) < 4) {
        options.push({ type: 'magic_rarity', option: epicMagic, weight: isHeart ? 50 : 40 });
    }

    if (isHeart) {
        // No fechamento do pity (#5) e no sacrifício, "anti-azar" precisa
        // significar qualidade real; não apenas o foco elemental.
        if (!context.forceQuality) {
            options.push({
                type: 'heart_elemental_focus',
                option: { key: 'heart_elemental_focus', name: 'Sintonia Elemental de Heart' },
                weight: 50,
            });
        }
        return options;
    }

    if (roll.kingdomKey === 'clover' && roll.raceKey === 'humano') {
        (availableRacePool || [])
            .filter((race) => race.key === 'bruxa' || race.key === 'anao')
            .forEach((race) => {
                options.push({ type: 'race', option: race, weight: 30 });
            });
    }

    return options;
}

function applyMercyFavor(
    config,
    roll,
    previousRolls = [],
    availableRacePool = [],
    availableMagicRarityPool = config.lists.magicRarities,
    options = {}
) {
    if (hasGoodRollMarker(roll)) return roll;

    const chance = options.forceMercy ? 1 : getMercyUpgradeChance(previousRolls);
    if (chance <= 0 || Math.random() >= chance) return roll;

    const upgradeOptions = getMercyUpgradeOptions(
        config,
        roll,
        availableRacePool,
        availableMagicRarityPool,
        { forceQuality: Boolean(options.forceMercy) || chance >= 1 }
    );
    if (!upgradeOptions.length) return roll;

    const upgrade = rollWeighted(upgradeOptions, 'weight');
    if (!upgrade) return roll;

    applyRollOption(roll, upgrade.type, upgrade.option);
    roll.favorApplied = upgrade.type;
    return roll;
}

function finalizeRoll(roll) {
    return {
        ...roll,
        summary: buildRollSummary(roll),
        payload: {
            kingdomKey: roll.kingdomKey,
            socialClassKey: roll.socialClassKey,
            raceKey: roll.raceKey,
            grimoireKey: roll.grimoireKey,
            magicRarityKey: roll.magicRarityKey,
            favorApplied: roll.favorApplied || null,
            elementalFavor: Boolean(roll.elementalFavor),
            version: roll.rollVersion,
        },
    };
}

function buildRoll(nextRollNumber, kingdom, race, socialClass, grimoire, magicRarity) {
    return {
        rollNumber: nextRollNumber,
        rollVersion: 'clover_base_v2',
        kingdom: kingdom.name,
        kingdomKey: kingdom.key,
        socialClass: socialClass.name,
        socialClassKey: socialClass.key,
        family: '-',
        familyKey: null,
        race: race.name,
        raceKey: race.key,
        grimoire: grimoire.name,
        grimoireKey: grimoire.key,
        grimoireRank: grimoire.rank || '-',
        grimoireSymbol: grimoire.symbol || '-',
        magicRarity: magicRarity.name,
        magicRarityKey: magicRarity.key,
        magicScope: MAGIC_SCOPE_BY_KINGDOM[kingdom.key] || '-',
    };
}

function generateBaseRoll(nextRollNumber, options = {}) {
    const config = loadCloverConfigs();
    const kingdom = rollWeighted(config.lists.kingdoms);
    const baseRacePool = getRacePool(config, kingdom.key);
    const racePool = options.sacrifice
        ? applySacrificeRaceWeights(baseRacePool, kingdom.key)
        : baseRacePool;
    const race = rollWeighted(racePool);
    const socialClass = race.key === 'humano'
        ? rollWeighted(config.lists.socialClasses)
        : {
            key: 'nao_se_aplica',
            name: 'N/A',
    };
    const grimoire = rollWeighted(getGrimoirePool(config, kingdom.key));
    const magicRarityPool = options.sacrifice
        ? applySacrificeMagicWeights(config.lists.magicRarities)
        : config.lists.magicRarities;
    const magicRarity = rollWeighted(magicRarityPool);

    const roll = buildRoll(nextRollNumber, kingdom, race, socialClass, grimoire, magicRarity);
    return finalizeRoll(applyMercyFavor(
        config,
        roll,
        options.previousRolls || [],
        racePool,
        magicRarityPool,
        options
    ));
}

async function generateAvailableBaseRoll(db, nextRollNumber, options = {}) {
    const config = loadCloverConfigs();
    const kingdomCandidates = [];

    for (const kingdomOption of config.lists.kingdoms) {
        const availableRaces = await filterAvailableSlotOptions(
            db,
            'race',
            getRacePool(config, kingdomOption.key)
        );
        const availableGrimoires = await filterAvailableSlotOptions(
            db,
            'grimoire',
            getGrimoirePool(config, kingdomOption.key)
        );
        if (!availableRaces.length || !availableGrimoires.length) continue;
        kingdomCandidates.push({
            ...kingdomOption,
            availableRaces,
            availableGrimoires,
        });
    }

    if (!kingdomCandidates.length) {
        const error = new Error('Nao existem combinacoes de reino, raca e grimorio com vaga para um novo roll.');
        error.code = 'NO_AVAILABLE_BASE_ROLL';
        throw error;
    }

    const kingdom = rollWeighted(kingdomCandidates);
    const racePool = options.sacrifice
        ? applySacrificeRaceWeights(kingdom.availableRaces, kingdom.key)
        : kingdom.availableRaces;
    const race = rollWeighted(racePool);
    const socialClass = race.key === 'humano'
        ? rollWeighted(config.lists.socialClasses)
        : {
            key: 'nao_se_aplica',
            name: 'N/A',
        };
    const grimoire = rollWeighted(kingdom.availableGrimoires);
    const baseMagicRarityPool = options.sacrifice
        ? applySacrificeMagicWeights(config.lists.magicRarities)
        : config.lists.magicRarities;
    const magicRarityPool = await filterAvailableMagicRarities(db, config, baseMagicRarityPool, {
        kingdomKey: kingdom.key,
    });
    if (!magicRarityPool.length) {
        const error = new Error('Nao existem raridades magicas com opcoes disponiveis para este roll.');
        error.code = 'NO_AVAILABLE_MAGIC_RARITY';
        throw error;
    }
    const magicRarity = rollWeighted(magicRarityPool);

    const roll = buildRoll(nextRollNumber, kingdom, race, socialClass, grimoire, magicRarity);
    return finalizeRoll(applyMercyFavor(
        config,
        roll,
        options.previousRolls || [],
        racePool,
        magicRarityPool,
        options
    ));
}

module.exports = {
    applySacrificeMagicWeights,
    filterAvailableMagicRarities,
    filterAvailableSlotOptions,
    generateAvailableBaseRoll,
    generateBaseRoll,
    getMercyUpgradeChance,
    getMercyUpgradeOptions,
    getRollQualityScore,
    hasAvailableMagicForRarity,
    hasGoodRollMarker,
    rollWeighted,
};