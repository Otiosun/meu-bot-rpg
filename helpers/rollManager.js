const path = require('path');

const { MAX_PLAYER_ROLLS } = require('../config/bot');
const {
    buildTemplateContext,
    renderEditableMessage,
    renderRollReviewMessage,
    renderRollStageMessage,
} = require('./onboardingFlow');
const { getSlotConfigOption } = require('./clover/configLoader');
const { countUsedSlots } = require('./clover/slotManager');
const { generateAvailableBaseRoll, generateBaseRoll, getRollQualityScore } = require('./clover/rollEngine');

const RARE_ROLL_IMAGE_PATH = path.join(process.cwd(), 'assets', 'onboarding', 'rare-roll.png');
const MYTHIC_ROLL_IMAGE_PATH = path.join(__dirname, '..', 'assets', 'onboarding', 'mythic-roll.png');
const FINAL_SACRIFICE_ROLL_NUMBER = MAX_PLAYER_ROLLS + 1;

const kingdoms = [
    { key: 'clover', label: 'Clover', chance: 25 },
    { key: 'spade', label: 'Spade', chance: 25 },
    { key: 'diamond', label: 'Diamond', chance: 25 },
    { key: 'heart', label: 'Heart', chance: 25 },
];

const socialClasses = [
    { name: 'Miseravel/Marginal', chance: 22 },
    { name: 'Plebeu', chance: 28 },
    { name: 'Artesao/Comerciante', chance: 20 },
    { name: 'Burguesia', chance: 17 },
    { name: 'Nobreza', chance: 8 },
    { name: 'Realeza', chance: 5 },
];

const racePoolsByKingdom = {
    clover: [
        { name: 'Humano', chance: 62 },
        { name: 'Bruxa', chance: 20 },
        { name: 'Anao', chance: 15 },
        { name: 'Elfo', chance: 3 },
    ],
    heart: [
        { name: 'Humano', chance: 100 },
    ],
    spade: [
        { name: 'Humano', chance: 100 },
    ],
    diamond: [
        { name: 'Humano', chance: 100 },
    ],
};

const ANOMALOUS_GRIMOIRE_CHANCE = 0.5;
const NORMAL_GRIMOIRE_CHANCE = 100 - ANOMALOUS_GRIMOIRE_CHANCE;

// Rare/anomalous grimoires keep an absolute 0.5%; common/rare keep the listed ratio in the remaining 99.5%.
function normalGrimoireChance(chance) {
    return (chance * NORMAL_GRIMOIRE_CHANCE) / 100;
}

const grimoirePoolsByKingdom = {
    clover: {
        3: { label: '3 Folhas', fullLabel: 'Grimório de 3 Folhas', chance: normalGrimoireChance(95) },
        4: { label: '4 Folhas', fullLabel: 'Grimório de 4 Folhas', chance: normalGrimoireChance(5) },
        demon: { label: '5 Folhas', fullLabel: 'Grimório de 5 Folhas', chance: ANOMALOUS_GRIMOIRE_CHANCE, rankLabel: '5F' },
    },
    spade: {
        3: { label: '1 Espada', fullLabel: 'Grimório de 1 Espada', chance: normalGrimoireChance(93) },
        4: { label: '2 Espadas', fullLabel: 'Grimório de 2 Espadas', chance: normalGrimoireChance(7) },
        demon: { label: '3 Espadas', fullLabel: 'Grimório de 3 Espadas', chance: ANOMALOUS_GRIMOIRE_CHANCE, rankLabel: '3 Espadas' },
    },
    heart: {
        3: { label: 'Coração', fullLabel: 'Grimório de Coração', chance: normalGrimoireChance(93) },
        4: { label: 'Coração Duplo', fullLabel: 'Grimório de Coração Duplo', chance: normalGrimoireChance(7) },
        demon: { label: 'Coração Partido', fullLabel: 'Grimório de Coração Partido', chance: ANOMALOUS_GRIMOIRE_CHANCE, rankLabel: 'Coração Partido' },
    },
    diamond: {
        3: { label: 'Diamante', fullLabel: 'Grimório de Diamante', chance: normalGrimoireChance(94) },
        4: { label: 'Diamante Lapidado', fullLabel: 'Grimório de Diamante Lapidado', chance: normalGrimoireChance(6) },
        demon: { label: 'Diamante Quebrado', fullLabel: 'Grimório de Diamante Quebrado', chance: 0, rankLabel: 'Diamante Quebrado' },
    },
};

const magicRarities = [
    { name: 'Mitica', chance: 1 },
    { name: 'Lendaria', chance: 10 },
    { name: 'Epica', chance: 17 },
    { name: 'Rara', chance: 30 },
    { name: 'Incomum', chance: 42 },
];

const magicScopesByKingdom = {
    clover: 'Misto',
    spade: 'Misto',
    diamond: 'Misto',
    heart: 'Elemental',
};

const SOCIAL_CLASS_DISPLAY = {
    'Miseravel/Marginal': 'Miserável/Marginal',
    'Artesao/Comerciante': 'Artesão/Comerciante',
};

const RACE_DISPLAY = {
    Anao: 'Anão',
};

const GRIMOIRE_DISPLAY = {
    'Grimorio Demoniaco': 'Grim\u00f3rio Demon\u00edaco',
    'Coracao (3F)': 'Coração (3F)',
    'Duplo Coracao (4F)': 'Duplo Coração (4F)',
};

GRIMOIRE_DISPLAY['Trevo de 3 Folhas'] = 'Grimório de 3 Folhas';
GRIMOIRE_DISPLAY['Trevo de 4 Folhas'] = 'Grimório de 4 Folhas';
GRIMOIRE_DISPLAY['Grimorio Demoniaco'] = 'Grimório de 5 Folhas';
GRIMOIRE_DISPLAY['Espada (3F)'] = 'Grimório de 1 Espada';
GRIMOIRE_DISPLAY['Espadas Cruzadas (4F)'] = 'Grimório de 2 Espadas';
GRIMOIRE_DISPLAY['Coracao (3F)'] = 'Grimório de Coração';
GRIMOIRE_DISPLAY['Duplo Coracao (4F)'] = 'Grimório de Coração Duplo';
GRIMOIRE_DISPLAY['Diamante (3F)'] = 'Grimório de Diamante';
GRIMOIRE_DISPLAY['Diamante de 5 Pontas (4F)'] = 'Grimório de Diamante Lapidado';

const RARITY_META = {
    Comum: { label: 'Comum', emoji: '⚪' },
    Incomum: { label: 'Incomum', emoji: '🟢' },
    Rara: { label: 'Rara', emoji: '🔵' },
    Epica: { label: 'Épica', emoji: '🟣' },
    Lendaria: { label: 'Lendária', emoji: '🟡' },
    Mitica: { label: 'Mítica', emoji: '🔴' },
};

function padRollNumber(value) {
    return String(value).padStart(2, '0');
}

function rollWeighted(options) {
    const total = options.reduce((sum, option) => sum + option.chance, 0);
    const random = Math.random() * total;
    let current = 0;

    for (const option of options) {
        current += option.chance;
        if (random <= current) return option;
    }

    return options[options.length - 1];
}

function buildRollSummary(roll) {
    const parts = [roll.kingdom, roll.socialClass, roll.race, roll.grimoire, roll.magicRarity];
    return parts.join(' | ');
}

function generateFullRoll(nextRollNumber) {
    return generateBaseRoll(nextRollNumber);
}

function displaySocialClass(value) {
    return SOCIAL_CLASS_DISPLAY[value] || value || '-';
}

function displayRace(value) {
    return RACE_DISPLAY[value] || value || '-';
}

function displayGrimoire(value) {
    return GRIMOIRE_DISPLAY[value] || value || '-';
}

function getMagicRarityMeta(value) {
    return RARITY_META[value] || { label: value || '-', emoji: '⚪' };
}

function normalizeRollValue(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function parseRollPayload(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function getRollFavorLabel(roll) {
    const payload = parseRollPayload(roll?.roll_payload || roll?.payload);
    const favorApplied = roll?.favorApplied || payload.favorApplied || null;
    const elementalFavor = roll?.elementalFavor || payload.elementalFavor || favorApplied === 'heart_elemental_focus';

    if (elementalFavor) return 'Sintonia Elemental de Heart';
    if (favorApplied === 'magic_rarity') return 'Magia Épica garantida';
    if (favorApplied === 'race') return `Raça favorecida: ${displayRace(roll.race)}`;
    return null;
}

function getRollValue(roll, snakeKey, camelKey) {
    return roll?.[snakeKey] ?? roll?.[camelKey] ?? '';
}

function isFourLeafGrimoire(roll) {
    const key = normalizeRollValue(getRollValue(roll, 'grimoire_key', 'grimoireKey'));
    const rank = normalizeRollValue(getRollValue(roll, 'grimoire_rank', 'grimoireRank'));
    const name = normalizeRollValue(getRollValue(roll, 'grimoire', 'grimoire'));
    const symbol = normalizeRollValue(getRollValue(roll, 'grimoire_symbol', 'grimoireSymbol'));

    return key.endsWith('_4f')
        || rank === '4f'
        || name.includes('4 folhas')
        || name.includes('(4f)')
        || symbol.includes('4 folhas');
}

function isFiveLeafOrCorruptedGrimoire(roll) {
    const key = normalizeRollValue(getRollValue(roll, 'grimoire_key', 'grimoireKey'));
    const rank = normalizeRollValue(getRollValue(roll, 'grimoire_rank', 'grimoireRank'));
    const name = normalizeRollValue(getRollValue(roll, 'grimoire', 'grimoire'));

    return key.includes('demonic')
        || key.includes('broken')
        || rank.includes('demon')
        || name.includes('5 folhas')
        || name.includes('demoniaco')
        || name.includes('demonico')
        || name.includes('corrompido')
        || name.includes('coracao partido')
        || name.includes('diamante quebrado')
        || name.includes('costurado')
        || name.includes('3 espadas');
}

function isLegendaryMagic(roll) {
    const key = normalizeRollValue(getRollValue(roll, 'magic_rarity_key', 'magicRarityKey'));
    const name = normalizeRollValue(getRollValue(roll, 'magic_rarity', 'magicRarity'));
    return key === 'lendaria' || name.includes('lendaria');
}

function isMythicMagic(roll) {
    const key = normalizeRollValue(getRollValue(roll, 'magic_rarity_key', 'magicRarityKey'));
    const name = normalizeRollValue(getRollValue(roll, 'magic_rarity', 'magicRarity'));
    return key === 'mitica' || name.includes('mitica');
}

function isRace(roll, key) {
    const raceKey = normalizeRollValue(getRollValue(roll, 'race_key', 'raceKey'));
    const raceName = normalizeRollValue(getRollValue(roll, 'race', 'race'));
    return raceKey === key || raceName === key;
}

function isRoyalty(roll) {
    const classKey = normalizeRollValue(getRollValue(roll, 'social_class_key', 'socialClassKey'));
    const className = normalizeRollValue(getRollValue(roll, 'social_class', 'socialClass'));
    return classKey === 'realeza' || className === 'realeza';
}

function isHeartKingdom(roll) {
    const kingdomKey = normalizeRollValue(getRollValue(roll, 'kingdom_key', 'kingdomKey'));
    const kingdomName = normalizeRollValue(getRollValue(roll, 'kingdom', 'kingdom'));
    return kingdomKey === 'heart' || kingdomName === 'heart';
}

function renderHeartElementalRollWarning(roll) {
    if (!isHeartKingdom(roll)) return null;
    return '> *𝐀𝐯𝐢𝐬𝐨 𝐇𝐞𝐚𝐫𝐭:* se escolher magia não elemental/natural, vários benefícios exclusivos de Heart podem ser cortados.';
}

function getRareRollHighlights(roll) {
    const highlights = [];
    const has4F = isFourLeafGrimoire(roll);
    const has5F = isFiveLeafOrCorruptedGrimoire(roll);
    const hasLegendary = isLegendaryMagic(roll);
    const hasMythic = isMythicMagic(roll);
    const hasTopMagic = hasLegendary || hasMythic;
    const isElf = isRace(roll, 'elfo');
    const isWitch = isRace(roll, 'bruxa');
    const isDwarf = isRace(roll, 'anao');
    const hasRoyalty = isRoyalty(roll);

    if (hasMythic) highlights.push('mitica');
    if (has5F) highlights.push('grimorio_5f_ou_corrompido');
    if (isElf && hasTopMagic) highlights.push('elfo_lendaria_ou_mitica');
    if (isElf && has4F) highlights.push('elfo_4f');
    if (has4F && hasTopMagic) highlights.push('4f_lendaria_ou_mitica');
    if (hasRoyalty && has4F) highlights.push('realeza_4f');
    if (isWitch && has4F && hasTopMagic) highlights.push('bruxa_4f_lendaria_ou_mitica');
    if (isDwarf && has4F && hasTopMagic) highlights.push('anao_4f_lendaria_ou_mitica');

    if (!highlights.length && isElf) highlights.push('elfo');
    if (!highlights.length && has4F) highlights.push('4f');
    if (!highlights.length && hasLegendary) highlights.push('lendaria');

    return highlights;
}

function getRareRollImagePath(roll) {
    if (isMythicMagic(roll)) return MYTHIC_ROLL_IMAGE_PATH;
    return getRareRollHighlights(roll).length ? RARE_ROLL_IMAGE_PATH : null;
}

function buildRollTemplateContext(roll, count = 1, max = MAX_PLAYER_ROLLS) {
    const rarityMeta = getMagicRarityMeta(roll.magic_rarity || roll.magicRarity);
    return {
        rollCount: count,
        maxRolls: max,
        rollNumber: padRollNumber(roll.roll_number || roll.rollNumber),
        rarityEmoji: rarityMeta.emoji,
        magicRarity: rarityMeta.label,
        kingdom: roll.kingdom,
        socialClass: displaySocialClass(roll.social_class || roll.socialClass),
        family: '-',
        race: displayRace(roll.race),
        grimoire: displayGrimoire(roll.grimoire),
    };
}

async function getPlayerRollCount(db, playerId) {
    const row = await db.get('SELECT COUNT(*) AS total FROM player_rolls WHERE player_id = ?', [playerId]);
    return Number(row?.total || 0);
}

async function listPlayerRolls(db, playerId) {
    return db.all(
        `SELECT *
         FROM player_rolls
         WHERE player_id = ?
         ORDER BY roll_number ASC`,
        [playerId]
    );
}

async function getPlayerRollByNumber(db, playerId, rollNumber) {
    return db.get(
        `SELECT *
         FROM player_rolls
         WHERE player_id = ? AND roll_number = ?`,
        [playerId, rollNumber]
    );
}

function getLimitedRollSlot(category, roll) {
    const optionKey = category === 'race'
        ? roll?.raceKey || roll?.race_key
        : category === 'grimoire'
            ? roll?.grimoireKey || roll?.grimoire_key
            : null;
    if (!optionKey) return null;

    const option = getSlotConfigOption(category, optionKey);
    if (!option?.capacity) return null;

    return {
        category,
        key: option.key,
        capacity: option.capacity,
    };
}

function getRollSlotSource(category) {
    return category === 'race' ? 'roll_race' : 'roll_grimoire';
}

function getLimitedRollSlots(roll) {
    return [
        getLimitedRollSlot('race', roll),
        getLimitedRollSlot('grimoire', roll),
    ].filter(Boolean);
}

async function reserveGeneratedRollSlots(db, playerId, roll) {
    const slots = getLimitedRollSlots(roll);
    if (!slots.length) return;

    for (const slot of slots) {
        const source = getRollSlotSource(slot.category);
        await db.run(
            `UPDATE slot_reservations
             SET status = 'released'
             WHERE player_id = ?
               AND category = ?
               AND source = ?
               AND roll_number = ?
               AND status = 'pending'`,
            [playerId, slot.category, source, roll.rollNumber]
        );

        const usedCount = await countUsedSlots(db, slot.category, slot.key, { skipExpire: true });
        if (usedCount >= slot.capacity) {
            const error = new Error(`slot_full:${slot.category}:${slot.key}`);
            error.code = 'SLOT_FULL';
            error.slot = slot;
            throw error;
        }

        await db.run(
            `INSERT INTO slot_reservations
             (player_id, category, option_key, status, source, roll_number, expires_at, created_at)
             VALUES (?, ?, ?, 'pending', ?, ?, datetime('now', '+24 hours'), CURRENT_TIMESTAMP)`,
            [playerId, slot.category, slot.key, source, roll.rollNumber]
        );
    }
}

async function storeRoll(db, playerId, roll) {
    await db.run(
        `INSERT INTO player_rolls
         (player_id, roll_number, kingdom, social_class, family, race, grimoire, grimoire_rank, grimoire_symbol,
          magic_rarity, magic_scope, summary, roll_version, kingdom_key, social_class_key, race_key, grimoire_key,
          magic_rarity_key, roll_payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            playerId,
            roll.rollNumber,
            roll.kingdom,
            roll.socialClass,
            roll.family,
            roll.race,
            roll.grimoire,
            roll.grimoireRank,
            roll.grimoireSymbol,
            roll.magicRarity,
            roll.magicScope,
            roll.summary,
            roll.rollVersion || 'clover_base_v2',
            roll.kingdomKey || null,
            roll.socialClassKey || null,
            roll.raceKey || null,
            roll.grimoireKey || null,
            roll.magicRarityKey || null,
            JSON.stringify(roll.payload || {}),
        ]
    );

    await reserveGeneratedRollSlots(db, playerId, roll);
}

async function rollbackStoredRoll(db, playerId, rollNumber) {
    const number = Number(rollNumber || 0);
    if (!playerId || !number) {
        return { removed: 0, releasedReservations: 0 };
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        const removed = await db.run(
            `DELETE FROM player_rolls
             WHERE player_id = ? AND roll_number = ?`,
            [playerId, number]
        );
        const released = await db.run(
            `UPDATE slot_reservations
             SET status = 'released'
             WHERE player_id = ?
               AND roll_number = ?
               AND source IN ('roll_grimoire', 'roll_race')
               AND status = 'pending'`,
            [playerId, number]
        );
        await db.exec('COMMIT');

        return {
            removed: Number(removed?.changes || 0),
            releasedReservations: Number(released?.changes || 0),
        };
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

async function createAndStoreRoll(db, playerId) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
        if (Number(player?.roll_sacrifice_used || 0)) {
            const count = await getPlayerRollCount(db, playerId);
            await db.exec('COMMIT');
            return {
                ok: false,
                reason: 'sacrifice_used',
                count,
                max: MAX_PLAYER_ROLLS,
            };
        }

        const existingRolls = await listPlayerRolls(db, playerId);
        const count = existingRolls.length;
        if (count >= MAX_PLAYER_ROLLS) {
            await db.exec('COMMIT');
            return {
                ok: false,
                reason: 'limit_reached',
                count,
                max: MAX_PLAYER_ROLLS,
            };
        }

        const usedNumbers = new Set(existingRolls.map((roll) => Number(roll.roll_number)));
        const nextRollNumber = Array.from({ length: MAX_PLAYER_ROLLS }, (_, index) => index + 1)
            .find((number) => !usedNumbers.has(number));
        const roll = await generateAvailableBaseRoll(db, nextRollNumber, {
            previousRolls: existingRolls,
        });

        await storeRoll(db, playerId, roll);
        await db.exec('COMMIT');

        return {
            ok: true,
            roll,
            count: count + 1,
            max: MAX_PLAYER_ROLLS,
        };
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

async function createSacrificeFinalRoll(db, playerId, sacrificedRolls) {
    const roll = await generateAvailableBaseRoll(db, FINAL_SACRIFICE_ROLL_NUMBER, {
        previousRolls: sacrificedRolls,
        sacrifice: true,
        forceMercy: true,
    });
    await storeRoll(db, playerId, roll);

    return {
        ok: true,
        roll,
        count: 1,
        max: MAX_PLAYER_ROLLS,
    };
}

function renderRollBlock(roll, { isSelected = false } = {}) {
    const context = buildRollTemplateContext(roll);
    const lines = [
        `_` + `\`─( 𖥔 )───── 𝗥𝗼𝗹𝗹 #${context.rollNumber} ${context.rarityEmoji}\`` + `_`,
        '',
        `*𝐑𝐞𝐢𝐧𝐨:* ${context.kingdom}`,
        `*𝐂𝐥𝐚𝐬𝐬𝐞:* ${context.socialClass}`,
    ];

    lines.push(`*𝐑𝐚𝐜̧𝐚:* ${context.race}`);
    lines.push(`*𝐆𝐫𝐢𝐦𝐨́𝐫𝐢𝐨:* ${context.grimoire}`);
    lines.push(`*𝐑𝐚𝐫𝐢𝐝𝐚𝐝𝐞 𝐌𝐚́𝐠𝐢𝐜𝐚:* ${context.magicRarity}`);

    if (isSelected) {
        lines.push('');
        lines.push('> *𝐀𝐭𝐮𝐚𝐥:* esse é o roll atual da sua ficha.');
    }

    const favorLabel = getRollFavorLabel(roll);
    if (favorLabel) {
        lines.push(`> *𝐅𝐚𝐯𝐨𝐫𝐞𝐜𝐢𝐦𝐞𝐧𝐭𝐨:* ${favorLabel}`);
    }

    if (Number(roll.roll_number || roll.rollNumber) === FINAL_SACRIFICE_ROLL_NUMBER) {
        lines.push(`> *𝐑𝐨𝐥𝐥 𝐟𝐢𝐧𝐚𝐥:* resultado do sacrifício dos ${MAX_PLAYER_ROLLS} rolls.`);
    }

    const heartWarning = renderHeartElementalRollWarning(roll);
    if (heartWarning) {
        lines.push(heartWarning);
    }

    return lines.join('\n');
}

function renderSavedRollMessage(result) {
    const text = renderEditableMessage(
        'sortear_pos',
        buildTemplateContext(buildRollTemplateContext(result.roll, result.count, result.max))
    );
    const favorLabel = getRollFavorLabel(result.roll);
    const extraLines = [];
    if (favorLabel) extraLines.push(`> *𝐅𝐚𝐯𝐨𝐫𝐞𝐜𝐢𝐦𝐞𝐧𝐭𝐨:* ${favorLabel}`);
    const heartWarning = renderHeartElementalRollWarning(result.roll);
    if (heartWarning) extraLines.push(heartWarning);
    return extraLines.length ? `${text}\n${extraLines.join('\n')}` : text;
}

function renderRollLimitMessage(count) {
    return renderRollStageMessage(count, { rollCount: count });
}

function renderRollList(rolls, selectedRollNumber = null) {
    if (!rolls.length) {
        return renderRollReviewMessage(0, { rollCount: 0 });
    }

    const blocks = rolls.map((roll) => renderRollBlock(roll, {
        isSelected: Number(selectedRollNumber) === Number(roll.roll_number),
    }));

    return renderRollReviewMessage(rolls.length, {
        rollCount: rolls.length,
        rollsList: blocks.join('\n\n'),
    });
}

module.exports = {
    FINAL_SACRIFICE_ROLL_NUMBER,
    MAX_PLAYER_ROLLS,
    buildRollTemplateContext,
    createSacrificeFinalRoll,
    createAndStoreRoll,
    getMagicRarityMeta,
    getRollFavorLabel,
    getRareRollHighlights,
    getRareRollImagePath,
    getPlayerRollByNumber,
    getPlayerRollCount,
    getRollQualityScore,
    listPlayerRolls,
    renderRollBlock,
    renderRollLimitMessage,
    renderRollList,
    renderSavedRollMessage,
    rollbackStoredRoll,
    storeRoll,
};