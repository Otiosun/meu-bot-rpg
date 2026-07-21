'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function update(relativePath, transform) {
    const filePath = path.join(root, relativePath);
    const before = fs.readFileSync(filePath, 'utf8');
    const after = transform(before);
    if (after === before) throw new Error(`${relativePath}: nenhuma alteracao aplicada`);
    fs.writeFileSync(filePath, after, 'utf8');
}

function replaceOnce(text, search, replacement, label) {
    const index = text.indexOf(search);
    if (index < 0) throw new Error(`Trecho nao encontrado: ${label}`);
    if (text.indexOf(search, index + search.length) >= 0) throw new Error(`Trecho ambiguo: ${label}`);
    return `${text.slice(0, index)}${replacement}${text.slice(index + search.length)}`;
}

function replaceRegex(text, expression, replacement, label) {
    const matches = text.match(expression);
    if (!matches) throw new Error(`Padrao nao encontrado: ${label}`);
    return text.replace(expression, replacement);
}

update('helpers/clover/rollEngine.js', (source) => {
    source = replaceOnce(source, `async function filterAvailableSlotOptions(db, category, options) {
    if (!db) return options;

    const available = [];
    for (const option of options) {
        if (option.capacity === null || option.capacity === undefined) {
            available.push(option);
            continue;
        }

        const used = await countUsedSlots(db, category, option.key);
        if (used < option.capacity) {
            available.push(option);
        }
    }

    return available.length ? available : options.filter((option) => option.capacity === null || option.capacity === undefined);
}`, `async function filterAvailableSlotOptions(db, category, options) {
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
}`, 'filtro de vagas do roll');

    source = replaceOnce(source, `    if (!magicOptions.length) return true;`, `    if (!magicOptions.length) {
        return normalizedRarity === 'comum' || normalizedRarity === 'incomum';
    }`, 'raridade sem catalogo');

    source = replaceOnce(source, `    if (available.length) return available;
    return options.filter((option) => !(
        context.kingdomKey === 'heart'
        && normalizeRollValue(option.key || option.name) === 'lendaria'
    ));`, `    return available;`, 'fallback de raridade esgotada');

    source = replaceOnce(source, `function getMercyUpgradeOptions(config, roll, availableRacePool) {
    const options = [];
    const epicMagic = findConfigOption(config.lists.magicRarities, 'epica');
    const isHeart = roll.kingdomKey === 'heart';

    if (epicMagic && getMagicRarityLevel(roll) < 4) {
        options.push({ type: 'magic_rarity', option: epicMagic, weight: isHeart ? 50 : 40 });
    }`, `function getMercyUpgradeOptions(config, roll, availableRacePool, availableMagicRarityPool = config.lists.magicRarities) {
    const options = [];
    const epicMagic = findConfigOption(availableMagicRarityPool, 'epica');
    const isHeart = roll.kingdomKey === 'heart';

    if (epicMagic && getMagicRarityLevel(roll) < 4) {
        options.push({ type: 'magic_rarity', option: epicMagic, weight: isHeart ? 50 : 40 });
    }`, 'misericordia respeita raridade disponivel');

    source = replaceOnce(source, `function applyMercyFavor(config, roll, previousRolls = [], availableRacePool = [], options = {}) {`, `function applyMercyFavor(
    config,
    roll,
    previousRolls = [],
    availableRacePool = [],
    availableMagicRarityPool = config.lists.magicRarities,
    options = {}
) {`, 'assinatura da misericordia');
    source = replaceOnce(source, `    const upgradeOptions = getMercyUpgradeOptions(config, roll, availableRacePool);`, `    const upgradeOptions = getMercyUpgradeOptions(config, roll, availableRacePool, availableMagicRarityPool);`, 'opcoes da misericordia');

    source = replaceOnce(source, `    return finalizeRoll(applyMercyFavor(config, roll, options.previousRolls || [], racePool, options));`, `    return finalizeRoll(applyMercyFavor(
        config,
        roll,
        options.previousRolls || [],
        racePool,
        magicRarityPool,
        options
    ));`, 'roll base aplica misericordia');

    source = replaceRegex(source, /async function generateAvailableBaseRoll\(db, nextRollNumber, options = \{\}\) \{[\s\S]*?\n\}/, `async function generateAvailableBaseRoll(db, nextRollNumber, options = {}) {
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
}`, 'gerador disponivel completo');

    source = replaceOnce(source, `    generateAvailableBaseRoll,
    generateBaseRoll,
    getRollQualityScore,`, `    filterAvailableMagicRarities,
    filterAvailableSlotOptions,
    generateAvailableBaseRoll,
    generateBaseRoll,
    getMercyUpgradeOptions,
    getRollQualityScore,
    hasAvailableMagicForRarity,`, 'exports de teste do roll');
    return source;
});

update('helpers/magicManager.js', (source) => {
    source = replaceOnce(source, `const {
    expireOldReservations,
    occupySlot,
    releaseReservation,
} = require('./clover/slotManager');`, `const {
    countUsedSlots,
    expireOldReservations,
    occupySlot,
    releaseReservation,
    reserveSlot,
} = require('./clover/slotManager');
const { getSlotConfigOption } = require('./clover/configLoader');`, 'imports canonicos de magia');

    source = replaceOnce(source, `function getMagicSlotKey(label) {
    return normalizeMagicLabel(label)
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}`, `function getMagicSlotKey(label) {
    return normalizeMagicLabel(label)
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function withCanonicalMagicCapacity(option) {
    if (!option) return null;
    const key = option.key || getMagicSlotKey(option.label);
    const configured = getSlotConfigOption('magic', key);
    return {
        ...option,
        key,
        capacity: configured ? configured.capacity ?? null : option.capacity ?? null,
    };
}`, 'capacidade canonica da magia');

    source = replaceRegex(source, /async function getMagicUsageMap\(db, excludePlayerId = null\) \{[\s\S]*?\n\}/, `async function getMagicUsageMap(db, excludePlayerId = null) {
    const usage = new Map();
    for (const rawOption of ALL_MAGICS) {
        const option = withCanonicalMagicCapacity(rawOption);
        if (!option.capacity) continue;
        const usedCount = await countUsedSlots(db, 'magic', option.key, { excludePlayerId });
        usage.set(normalizeMagicLabel(option.label), usedCount);
    }
    return usage;
}`, 'mapa canonico de uso de magias');

    source = replaceRegex(source, /async function savePendingMagicConfirmation\(db, playerId, magicLabel, rollNumber = null\) \{[\s\S]*?\n\}/, `async function savePendingMagicConfirmation(db, playerId, magicLabel, rollNumber = null) {
    await purgeExpiredMagicConfirmations(db);
    await clearPendingMagicConfirmation(db, playerId);

    const option = withCanonicalMagicCapacity(
        ALL_MAGICS.find((item) => normalizeMagicLabel(item.label) === normalizeMagicLabel(magicLabel))
    );
    if (!option) return { ok: false, reason: 'magic_not_found' };

    let reservation = null;
    if (option.capacity) {
        reservation = await reserveSlot(
            db,
            playerId,
            'magic',
            option.key,
            'magic_choice',
            rollNumber,
            { ttlHours: 1 }
        );
        if (!reservation.ok) return reservation;
    }

    try {
        await db.run(
            \`INSERT INTO pending_magic_confirmations (player_id, magic_label, roll_number, created_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(player_id) DO UPDATE SET
                 magic_label = excluded.magic_label,
                 roll_number = excluded.roll_number,
                 created_at = CURRENT_TIMESTAMP\`,
            [playerId, option.label, rollNumber]
        );
    } catch (error) {
        if (option.capacity) await releaseReservation(db, playerId, 'magic', option.key).catch(() => null);
        throw error;
    }

    return { ok: true, reservation };
}`, 'reserva real de magia por uma hora');

    source = replaceOnce(source, `        const option = ALL_MAGICS.find((item) => normalizeMagicLabel(item.label) === normalizeMagicLabel(pending.magic_label));
        if (option?.capacity) {
            await releaseReservation(db, playerId, 'magic', getMagicSlotKey(option.label));
        }`, `        const option = withCanonicalMagicCapacity(
            ALL_MAGICS.find((item) => normalizeMagicLabel(item.label) === normalizeMagicLabel(pending.magic_label))
        );
        if (option?.capacity) await releaseReservation(db, playerId, 'magic', option.key);`, 'liberacao de reserva de magia');

    source = replaceRegex(source, /async function getMagicAvailability\(db, magicLabel, excludePlayerId = null\) \{[\s\S]*?\n\}/, `async function getMagicAvailability(db, magicLabel, excludePlayerId = null) {
    const option = withCanonicalMagicCapacity(
        ALL_MAGICS.find((item) => normalizeMagicLabel(item.label) === normalizeMagicLabel(magicLabel))
    );
    if (!option) return null;

    const usedCount = option.capacity
        ? await countUsedSlots(db, 'magic', option.key, { excludePlayerId })
        : 0;
    const capacity = option.capacity || null;

    return {
        option,
        usedCount,
        capacity,
        available: capacity ? usedCount < capacity : true,
        slotText: formatMagicSlot(option, usedCount),
    };
}`, 'disponibilidade canonica de magia');

    source = replaceOnce(source, `function renderMagicLine(option, usedCount, roll = null) {
    const slotSuffix = option.capacity ? \` *(\${usedCount}/\${option.capacity})*\` : '';
    const raritySuffix = roll
        ? isMagicAllowedForRoll(option, roll) ? ' · disponivel' : ' · acima do roll'
        : '';
    return \`﹒ \${option.label}\${slotSuffix}\${raritySuffix}\`;
}`, `function renderMagicLine(rawOption, usedCount, roll = null) {
    const option = withCanonicalMagicCapacity(rawOption);
    const full = Boolean(option.capacity && usedCount >= option.capacity);
    const slotSuffix = option.capacity ? \` *(\${usedCount}/\${option.capacity})*\` : '';
    const stateSuffix = full
        ? ' · esgotada'
        : roll
            ? isMagicAllowedForRoll(option, roll) ? ' · disponível' : ' · acima do roll'
            : '';
    return \`﹒ \${option.label}\${slotSuffix}\${stateSuffix}\`;
}`, 'linha de magia com esgotamento');

    source = replaceOnce(source, `            const usedCount = usageMap.get(normalizeMagicLabel(item.label)) || 0;
            lines.push(renderMagicLine({ ...item, rarity: group.rarity, key: getMagicSlotKey(item.label) }, usedCount, roll));`, `            const option = withCanonicalMagicCapacity({
                ...item,
                rarity: group.rarity,
                key: getMagicSlotKey(item.label),
            });
            const usedCount = usageMap.get(normalizeMagicLabel(option.label)) || 0;
            lines.push(renderMagicLine(option, usedCount, roll));`, 'lista de magia canonica');
    return source;
});

update('helpers/clover/systemMessages.js', (source) => {
    source = replaceOnce(source, `async function formatSlot(db, category, item) {
    if (item.capacity === null || item.capacity === undefined) return '[livre]';
    const used = db ? await countUsedSlots(db, category, item.key) : 0;
    return \`[\${used}/\${item.capacity}]\`;
}`, `async function formatSlot(db, category, item) {
    if (item.capacity === null || item.capacity === undefined) return '[livre]';
    const used = db ? await countUsedSlots(db, category, item.key) : 0;
    const full = used >= item.capacity;
    return \`[\${used}/\${item.capacity}\${full ? ' · esgotado' : ''}]\`;
}`, 'status visual da vaga');

    source = source
        .replace('As vagas abaixo sao as vagas atuais do sistema. Elas so ocupam quando a ficha e confirmada.', 'As vagas abaixo vêm do banco em tempo real. Fichas confirmadas e reservas ativas já seguram vaga.')
        .replace('Familia so ocupa vaga quando a ficha for confirmada.', 'A contagem inclui fichas confirmadas e qualquer reserva ativa da mesma família.')
        .replace('*ⓘ Rαçα sαı no roll ᥱ só ocupα vαgα quαndo α fıchα ᥱ́ confırmαdα.*', '*ⓘ Rαçα sαı no roll. Rαçα lımıtαdα fıcα rᥱsᥱrvαdα durαntᥱ o roll αtıvo ᥱ ᥱ́ fıxαdα nα confırmαçα̃o.*')
        .replace('*ⓘ Grımórıo sαı no roll ᥱ só ocupα vαgα quαndo α fıchα ᥱ́ confırmαdα.*', '*ⓘ Grımórıo sαı no roll. Opçα̃o lımıtαdα fıcα rᥱsᥱrvαdα durαntᥱ o roll αtıvo ᥱ ᥱ́ fıxαdα nα confırmαçα̃o.*')
        .replace('*ⓘ As vagas abaixo sao calculadas pelo banco agora. Grimório só ocupa vaga quando a ficha é confirmada.*', '*ⓘ As vagas abaixo vêm do banco em tempo real e incluem reservas ativas dos rolls.*');
    return source;
});

console.log('Patch de vagas reais e rolls aplicado.');
