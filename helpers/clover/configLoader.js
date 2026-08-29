const fs = require('fs');
const path = require('path');

// Runtime configs must travel with the code revision that loaded them.
// PM2 may intentionally use another cwd so the live SQLite stays in place;
// never let that make a new runtime read stale balance files from that cwd.
const CONFIG_DIR = path.join(__dirname, '..', '..', 'data', 'clover');
const KEY_PATTERN = /^[a-z0-9_]+$/;

const CONFIG_SPECS = {
    kingdoms: { fileName: 'reinos.json', category: 'kingdom' },
    races: { fileName: 'racas.json', category: 'race' },
    socialClasses: { fileName: 'classesSociais.json', category: 'social_class' },
    grimoires: { fileName: 'grimorios.json', category: 'grimoire' },
    families: { fileName: 'familias.json', category: 'family' },
    magics: { fileName: 'magias.json', category: 'magic' },
    magicRarities: { fileName: 'raridadesMagicas.json', category: 'magic_rarity' },
    commonAptitudes: { fileName: 'aptidoesComuns.json', category: 'common_aptitude' },
    rareAptitudes: { fileName: 'aptidoesRaras.json', category: 'rare_aptitude' },
    commonMarks: { fileName: 'marcasComuns.json', category: 'common_mark' },
    rareMarks: { fileName: 'marcasRaras.json', category: 'rare_mark' },
    anomalies: { fileName: 'anomalias.json', category: 'anomaly' },
};

const VALID_CATEGORIES = new Set([
    ...Object.values(CONFIG_SPECS).map((spec) => spec.category),
]);

const SLOT_CONFIG_BY_CATEGORY = {
    family: 'families',
    anomaly: 'anomalies',
    magic: 'magics',
    race: 'races',
    grimoire: 'grimoires',
};

let cachedConfig = null;

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function readJsonArray(filePath, configId, errors) {
    if (!fs.existsSync(filePath)) {
        errors.push(`${configId}: arquivo nao encontrado em ${filePath}`);
        return [];
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!Array.isArray(parsed)) {
            errors.push(`${configId}: o arquivo precisa conter uma lista JSON.`);
            return [];
        }
        return parsed;
    } catch (error) {
        errors.push(`${configId}: JSON invalido (${error.message}).`);
        return [];
    }
}

function describeItem(configId, index, item) {
    const key = item && typeof item === 'object' ? item.key : null;
    return `${configId}[${index}]${key ? ` (${key})` : ''}`;
}

function normalizeCapacity(rawItem, location, errors) {
    const hasCapacity = hasOwn(rawItem, 'capacity');
    const hasVagas = hasOwn(rawItem, 'vagas');

    if (hasCapacity && hasVagas && rawItem.capacity !== rawItem.vagas) {
        errors.push(`${location}: use apenas capacity ou vagas, ou mantenha os dois com o mesmo valor.`);
    }

    if (!hasCapacity && !hasVagas) return undefined;

    const rawCapacity = hasCapacity ? rawItem.capacity : rawItem.vagas;
    if (rawCapacity === null) return null;

    if (!Number.isInteger(rawCapacity) || rawCapacity <= 0) {
        errors.push(`${location}: capacity/vagas precisa ser inteiro positivo ou null.`);
        return undefined;
    }

    return rawCapacity;
}

function validateNumberField(item, fieldName, location, errors, { integer = false, min = 0 } = {}) {
    if (!hasOwn(item, fieldName)) return;

    const value = item[fieldName];
    const isValidNumber = typeof value === 'number'
        && Number.isFinite(value)
        && value >= min
        && (!integer || Number.isInteger(value));

    if (!isValidNumber) {
        errors.push(`${location}: ${fieldName} precisa ser numero${integer ? ' inteiro' : ''} >= ${min}.`);
    }
}

function validateWeights(weights, location, errors) {
    if (!hasOwn({ weights }, 'weights') || weights === undefined) return;

    if (!weights || typeof weights !== 'object' || Array.isArray(weights)) {
        errors.push(`${location}: weightsByKingdom precisa ser um objeto.`);
        return;
    }

    Object.entries(weights).forEach(([kingdomKey, chance]) => {
        if (!KEY_PATTERN.test(kingdomKey)) {
            errors.push(`${location}: reino invalido em weightsByKingdom (${kingdomKey}).`);
        }
        if (typeof chance !== 'number' || !Number.isFinite(chance) || chance < 0) {
            errors.push(`${location}: peso do reino ${kingdomKey} precisa ser numero >= 0.`);
        }
    });
}

function normalizeAndValidateList(configId, spec, rawList, errors) {
    const seenKeys = new Set();
    const normalizedList = [];

    rawList.forEach((rawItem, index) => {
        const location = describeItem(configId, index, rawItem);

        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
            errors.push(`${location}: item precisa ser um objeto.`);
            return;
        }

        const item = { ...rawItem };
        const key = String(item.key || '').trim();
        const name = String(item.name || '').trim();
        const category = String(item.category || '').trim();

        if (!key) {
            errors.push(`${location}: key e obrigatoria.`);
        } else if (!KEY_PATTERN.test(key)) {
            errors.push(`${location}: key deve usar apenas letras minusculas, numeros e underscore.`);
        } else if (seenKeys.has(key)) {
            errors.push(`${location}: key duplicada nesta lista.`);
        } else {
            seenKeys.add(key);
        }

        if (!name) {
            errors.push(`${location}: name e obrigatorio.`);
        }

        if (!category) {
            errors.push(`${location}: category e obrigatoria.`);
        } else if (!VALID_CATEGORIES.has(category)) {
            errors.push(`${location}: category desconhecida (${category}).`);
        } else if (category !== spec.category) {
            errors.push(`${location}: category deveria ser ${spec.category}, recebeu ${category}.`);
        }

        const capacity = normalizeCapacity(item, location, errors);
        if (capacity !== undefined) item.capacity = capacity;

        validateNumberField(item, 'chance', location, errors);
        validateNumberField(item, 'level', location, errors, { integer: true, min: 1 });
        validateWeights(item.weightsByKingdom, location, errors);

        normalizedList.push({
            ...item,
            key,
            name,
            category,
        });
    });

    return normalizedList;
}

function validateReferences(lists, errors) {
    const kingdomKeys = new Set((lists.kingdoms || []).map((item) => item.key));
    const socialClassKeys = new Set((lists.socialClasses || []).map((item) => item.key));

    (lists.races || []).forEach((race) => {
        Object.keys(race.weightsByKingdom || {}).forEach((kingdomKey) => {
            if (!kingdomKeys.has(kingdomKey)) {
                errors.push(`racas (${race.key}): weightsByKingdom referencia reino inexistente (${kingdomKey}).`);
            }
        });
    });

    (lists.grimoires || []).forEach((grimoire) => {
        if (!kingdomKeys.has(grimoire.kingdomKey)) {
            errors.push(`grimorios (${grimoire.key}): kingdomKey inexistente (${grimoire.kingdomKey || '-'}).`);
        }
    });

    (lists.families || []).forEach((family) => {
        if (!Array.isArray(family.kingdomKeys) || !family.kingdomKeys.length) {
            errors.push(`familias (${family.key}): kingdomKeys precisa ter pelo menos um reino.`);
            return;
        }

        family.kingdomKeys.forEach((kingdomKey) => {
            if (!kingdomKeys.has(kingdomKey)) {
                errors.push(`familias (${family.key}): kingdomKey inexistente (${kingdomKey}).`);
            }
        });

        if (!Array.isArray(family.socialClassKeys) || !family.socialClassKeys.length) {
            errors.push(`familias (${family.key}): socialClassKeys precisa ter pelo menos uma classe social.`);
            return;
        }

        family.socialClassKeys.forEach((socialClassKey) => {
            if (!socialClassKeys.has(socialClassKey)) {
                errors.push(`familias (${family.key}): socialClassKey inexistente (${socialClassKey}).`);
            }
        });
    });
}

function buildConfigResult(lists) {
    const maps = {};
    const byCategory = {};

    Object.entries(CONFIG_SPECS).forEach(([configId, spec]) => {
        const list = lists[configId] || [];
        const map = new Map(list.map((item) => [item.key, item]));
        maps[configId] = map;
        byCategory[spec.category] = map;
    });

    return {
        lists,
        maps,
        byCategory,
    };
}

function loadCloverConfigs({ forceReload = false } = {}) {
    if (cachedConfig && !forceReload) return cachedConfig;

    const errors = [];
    const lists = {};

    Object.entries(CONFIG_SPECS).forEach(([configId, spec]) => {
        const filePath = path.join(CONFIG_DIR, spec.fileName);
        const rawList = readJsonArray(filePath, configId, errors);
        lists[configId] = normalizeAndValidateList(configId, spec, rawList, errors);
    });

    validateReferences(lists, errors);

    if (errors.length) {
        throw new Error([
            'Config Clover invalida:',
            ...errors.map((error) => `- ${error}`),
        ].join('\n'));
    }

    cachedConfig = buildConfigResult(lists);
    return cachedConfig;
}

function clearCloverConfigCache() {
    cachedConfig = null;
}

function getConfigOption(configId, optionKey) {
    const config = loadCloverConfigs();
    const map = config.maps[configId];
    if (!map) {
        throw new Error(`Config Clover desconhecida: ${configId}`);
    }
    return map.get(String(optionKey || '').trim()) || null;
}

function getSlotConfigOption(category, optionKey) {
    const configId = SLOT_CONFIG_BY_CATEGORY[category];
    if (!configId) return null;
    return getConfigOption(configId, optionKey);
}

module.exports = {
    CONFIG_SPECS,
    SLOT_CONFIG_BY_CATEGORY,
    VALID_CATEGORIES,
    clearCloverConfigCache,
    getConfigOption,
    getSlotConfigOption,
    loadCloverConfigs,
};
