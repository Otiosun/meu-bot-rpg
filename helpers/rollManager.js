const { COMMAND_PREFIX, MAX_PLAYER_ROLLS } = require('../config/bot');

const kingdoms = [
    { key: 'clover', label: 'Clover', chance: 36 },
    { key: 'spade', label: 'Spade', chance: 22 },
    { key: 'diamond', label: 'Diamond', chance: 20 },
    { key: 'heart', label: 'Heart', chance: 22 },
];

const socialClasses = [
    { name: 'Miseravel/Marginal', chance: 24 },
    { name: 'Plebeu', chance: 24 },
    { name: 'Artesao/Comerciante', chance: 18 },
    { name: 'Burguesia', chance: 14 },
    { name: 'Nobreza', chance: 12 },
    { name: 'Realeza', chance: 8 },
];

const racePoolsByKingdom = {
    clover: [
        { name: 'Humano', chance: 52 },
        { name: 'Bruxa', chance: 20 },
        { name: 'Elfo', chance: 10 },
        { name: 'Anao', chance: 10 },
        { name: 'Hibrido', chance: 8 },
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

const grimoirePoolsByKingdom = {
    clover: {
        3: { label: 'Trevo', fullLabel: 'Trevo de 3 Folhas', chance: 90 },
        4: { label: 'Trevo de 4 Folhas', fullLabel: 'Trevo de 4 Folhas', chance: 10 },
    },
    spade: {
        3: { label: 'Espada', fullLabel: 'Espada (3F)', chance: 88 },
        4: { label: 'Espadas Cruzadas', fullLabel: 'Espadas Cruzadas (4F)', chance: 12 },
    },
    heart: {
        3: { label: 'Coracao', fullLabel: 'Coracao (3F)', chance: 88 },
        4: { label: 'Duplo Coracao', fullLabel: 'Duplo Coracao (4F)', chance: 12 },
    },
    diamond: {
        3: { label: 'Diamante', fullLabel: 'Diamante (3F)', chance: 89 },
        4: { label: 'Diamante de 5 Pontas', fullLabel: 'Diamante de 5 Pontas (4F)', chance: 11 },
    },
};

const magicRarities = [
    { name: 'Lendaria', chance: 9 },
    { name: 'Epica', chance: 18 },
    { name: 'Rara', chance: 28 },
    { name: 'Comum', chance: 45 },
];

const magicScopesByKingdom = {
    clover: 'Misto',
    spade: 'Misto',
    diamond: 'Misto',
    heart: 'Elemental',
};

const royalFamilies = ['Kira', 'Silva', 'Vermillion'];
const nobleFamilies = ['Roselei', 'Vaude', 'Swallowtail', 'Boismotier', 'Adlai', 'Faust', 'Vangeance', 'Legolant'];
const bourgeoisOrigins = ['Casa Mercante Astra', 'Companhia Dourada', 'Guilda de Vales', 'Banco Bellatore'];

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

function randomFrom(list) {
    return list[Math.floor(Math.random() * list.length)];
}

function resolveFamily(socialClass) {
    if (socialClass === 'Realeza') return randomFrom(royalFamilies);
    if (socialClass === 'Nobreza') return randomFrom(nobleFamilies);
    if (socialClass === 'Burguesia') return randomFrom(bourgeoisOrigins);
    return '-';
}

function buildRollSummary(roll) {
    const parts = [roll.kingdom, roll.socialClass, roll.race, roll.grimoire, roll.magicRarity];
    if (roll.family && roll.family !== '-') parts.splice(2, 0, roll.family);
    return parts.join(' | ');
}

function generateFullRoll(nextRollNumber) {
    const kingdom = rollWeighted(kingdoms);
    const socialClass = rollWeighted(socialClasses).name;
    const family = resolveFamily(socialClass);
    const race = rollWeighted(racePoolsByKingdom[kingdom.key]).name;
    const grimoireRank = Number(rollWeighted(Object.entries(grimoirePoolsByKingdom[kingdom.key]).map(([rank, data]) => ({
        rank,
        ...data,
    }))).rank);
    const grimoireData = grimoirePoolsByKingdom[kingdom.key][grimoireRank];
    const magicRarity = rollWeighted(magicRarities).name;

    return {
        rollNumber: nextRollNumber,
        kingdom: kingdom.label,
        kingdomKey: kingdom.key,
        socialClass,
        family,
        race,
        grimoire: grimoireData.fullLabel,
        grimoireRank: `${grimoireRank}F`,
        grimoireSymbol: grimoireData.label,
        magicRarity,
        magicScope: magicScopesByKingdom[kingdom.key],
        summary: buildRollSummary({
            kingdom: kingdom.label,
            socialClass,
            family,
            race,
            grimoire: grimoireData.fullLabel,
            magicRarity,
        }),
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

async function createAndStoreRoll(db, playerId) {
    const count = await getPlayerRollCount(db, playerId);
    if (count >= MAX_PLAYER_ROLLS) {
        return {
            ok: false,
            reason: 'limit_reached',
            count,
            max: MAX_PLAYER_ROLLS,
        };
    }

    const roll = generateFullRoll(count + 1);

    await db.run(
        `INSERT INTO player_rolls
         (player_id, roll_number, kingdom, social_class, family, race, grimoire, grimoire_rank, grimoire_symbol, magic_rarity, magic_scope, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        ]
    );

    return {
        ok: true,
        roll,
        count: count + 1,
        max: MAX_PLAYER_ROLLS,
    };
}

function renderRollBlock(roll, { includeHint = false } = {}) {
    const number = roll.roll_number || roll.rollNumber;
    const lines = [
        `*ᯓ➤ 𝐑𝗈𝗅𝗅 #${padRollNumber(number)}*`,
        '',
        `🏰 *Reino:* ${roll.kingdom}`,
        `💴 *Classe social:* ${roll.social_class || roll.socialClass}`,
        `👥 *Raça:* ${roll.race}`,
        `📖 *Grimório:* ${roll.grimoire}`,
        `✨ *Magia:* ${roll.magic_rarity || roll.magicRarity}`,
    ];

    if (roll.family && roll.family !== '-') {
        lines.splice(3, 0, `👑 *Família / origem:* ${roll.family}`);
    }

    if (includeHint) {
        lines.push('');
        lines.push(`Quando decidir, use o número deste roll na sua *${COMMAND_PREFIX}Ficha*.`);
    }

    return lines.join('\n');
}

function renderSavedRollMessage(result) {
    return [
        '🎁 *Roll salvo com sucesso!*',
        '',
        renderRollBlock(result.roll, { includeHint: false }),
        '',
        `Você está com *${result.count}/${result.max}* rolls salvos.`,
        '',
        '*Próximos passos:*',
        `• Use *${COMMAND_PREFIX}sortear* para tentar outro roll.`,
        `• Use *${COMMAND_PREFIX}rolls* para ver todos os rolls salvos.`,
        `• Use *${COMMAND_PREFIX}Ficha* para receber o modelo da ficha.`,
    ].join('\n');
}

function renderRollLimitMessage(count) {
    return [
        '⚠️ Você já atingiu seu limite de rolls.',
        '',
        `Limite atual: *${count}/${MAX_PLAYER_ROLLS}*`,
        `Use *${COMMAND_PREFIX}rolls* para ver todos os seus sorteios em bloco.`,
    ].join('\n');
}

function renderRollList(rolls, selectedRollNumber = null) {
    if (!rolls.length) {
        return [
            '🎲 Você ainda não tem rolls salvos.',
            '',
            `Use *${COMMAND_PREFIX}sortear* para gerar seu primeiro pacote completo.`,
        ].join('\n');
    }

    const blocks = ['🎲 *Seus rolls salvos*', ''];

    rolls.forEach((roll, index) => {
        const isSelected = Number(selectedRollNumber) === Number(roll.roll_number);
        blocks.push(renderRollBlock(roll));
        if (isSelected) {
            blocks.push('⭐ Este e o roll atualmente vinculado a sua ficha.');
        }
        if (index < rolls.length - 1) {
            blocks.push('', '────────', '');
        }
    });

    blocks.push('', `Total: *${rolls.length}/${MAX_PLAYER_ROLLS}*`);
    blocks.push(`Use *${COMMAND_PREFIX}Ficha* para receber ou revisar o modelo da ficha.`);

    return blocks.join('\n');
}

module.exports = {
    MAX_PLAYER_ROLLS,
    createAndStoreRoll,
    getPlayerRollByNumber,
    getPlayerRollCount,
    listPlayerRolls,
    renderRollBlock,
    renderRollLimitMessage,
    renderRollList,
    renderSavedRollMessage,
};
