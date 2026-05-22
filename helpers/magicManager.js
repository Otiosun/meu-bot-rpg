const { COMMAND_PREFIX } = require('../config/bot');

const magicPools = {
    Clover: [
        { key: 'agua', label: 'Agua', rarity: 'Comum' },
        { key: 'vento', label: 'Vento', rarity: 'Comum' },
        { key: 'fogo', label: 'Fogo', rarity: 'Comum' },
        { key: 'terra', label: 'Terra', rarity: 'Comum' },
        { key: 'planta', label: 'Planta', rarity: 'Rara' },
        { key: 'aco', label: 'Aco', rarity: 'Rara' },
        { key: 'sombra', label: 'Sombra', rarity: 'Epica' },
        { key: 'luz', label: 'Luz', rarity: 'Lendaria' },
    ],
    Heart: [
        { key: 'agua', label: 'Agua', rarity: 'Comum' },
        { key: 'vento', label: 'Vento', rarity: 'Comum' },
        { key: 'fogo', label: 'Fogo', rarity: 'Comum' },
        { key: 'terra', label: 'Terra', rarity: 'Comum' },
        { key: 'raio', label: 'Raio', rarity: 'Rara' },
        { key: 'gelo', label: 'Gelo', rarity: 'Rara' },
        { key: 'flor', label: 'Flor', rarity: 'Epica' },
        { key: 'tempestade', label: 'Tempestade', rarity: 'Lendaria' },
    ],
    Spade: [
        { key: 'gelo', label: 'Gelo', rarity: 'Comum' },
        { key: 'nevoa', label: 'Nevoa', rarity: 'Comum' },
        { key: 'ferro', label: 'Ferro', rarity: 'Rara' },
        { key: 'osso', label: 'Osso', rarity: 'Rara' },
        { key: 'sangue', label: 'Sangue', rarity: 'Epica' },
        { key: 'trevas', label: 'Trevas', rarity: 'Lendaria' },
    ],
    Diamond: [
        { key: 'cristal', label: 'Cristal', rarity: 'Comum' },
        { key: 'terra', label: 'Terra', rarity: 'Comum' },
        { key: 'metal', label: 'Metal', rarity: 'Rara' },
        { key: 'areia', label: 'Areia', rarity: 'Rara' },
        { key: 'minerio', label: 'Minerio', rarity: 'Epica' },
        { key: 'prisma', label: 'Prisma', rarity: 'Lendaria' },
    ],
};

const rarityOrder = {
    Comum: 1,
    Rara: 2,
    Epica: 3,
    Lendaria: 4,
};

function normalizeMagicInput(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function getAvailableMagicsForRoll(roll) {
    const pool = magicPools[roll.kingdom] || [];
    const cap = rarityOrder[roll.magic_rarity] || 1;
    return pool.filter((magic) => (rarityOrder[magic.rarity] || 0) <= cap);
}

function renderMagicChoicePrompt(roll, options) {
    const lines = [
        '✨ *Agora vamos para sua escolha de magia.*',
        '',
        `Seu reino: *${roll.kingdom}*`,
        `Sua raridade maxima: *${roll.magic_rarity}*`,
    ];

    if (roll.magic_scope === 'Elemental') {
        lines.push('Seu reino trabalha apenas com magias elementais.');
    }

    lines.push('');
    lines.push('Escolha uma das opcoes abaixo:');
    options.forEach((magic, index) => {
        lines.push(`${index + 1}. *${magic.label}* - ${magic.rarity}`);
    });

    lines.push('');
    lines.push(`Use *${COMMAND_PREFIX}magia <numero ou nome>* para escolher.`);

    return lines.join('\n');
}

async function isMagicAvailable(db, magicLabel) {
    const row = await db.get(
        `SELECT id
         FROM jogadores
         WHERE lower(magia) = lower(?)
         LIMIT 1`,
        [magicLabel]
    );
    return !row;
}

function findMagicOption(options, input) {
    if (!input) return null;
    if (/^\d+$/.test(input)) {
        return options[Number(input) - 1] || null;
    }

    const normalized = normalizeMagicInput(input);
    return options.find((magic) => normalizeMagicInput(magic.label) === normalized) || null;
}

module.exports = {
    findMagicOption,
    getAvailableMagicsForRoll,
    isMagicAvailable,
    renderMagicChoicePrompt,
};
