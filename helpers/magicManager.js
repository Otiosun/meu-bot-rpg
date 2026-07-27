const { COMMAND_PREFIX } = require('../config/bot');
const { getClosestTextMatches, normalizeText } = require('./textUtils');
const {
    countUsedSlots,
    expireOldReservations,
    occupySlot,
    releaseReservation,
    reserveSlot,
} = require('./clover/slotManager');
const { getSlotConfigOption } = require('./clover/configLoader');

const RARITY_META = {
    Comum: { label: 'Comum', headerLabel: '𝐂𝐎𝐌𝐔𝐌', emoji: '⚪', level: 1 },
    Incomum: { label: 'Incomum', headerLabel: '𝐈𝐍𝐂𝐎𝐌𝐔𝐌', emoji: '🟢', level: 2 },
    Rara: { label: 'Rara', headerLabel: '𝐑𝐀𝐑𝐀', emoji: '🔵', level: 3 },
    Epica: { label: 'Épica', headerLabel: '𝐄́𝐏𝐈𝐂𝐀', emoji: '🟣', level: 4 },
    Lendaria: { label: 'Lendária', headerLabel: '𝐋𝐄𝐍𝐃𝐀́𝐑𝐈𝐀', emoji: '🟡', level: 5 },
};

const MAGIC_GROUPS = [
    {
        rarity: 'Comum',
        items: [
            { label: 'Magia de Algodão' },
            { label: 'Magia de Arenito' },
            { label: 'Magia de Bolha' },
            { label: 'Magia de Cinzas' },
            { label: 'Magia de Cristal' },
            { label: 'Magia de Lama' },
            { label: 'Magia de Música' },
            { label: 'Magia de Névoa' },
            { label: 'Magia de Óleo Negro' },
            { label: 'Magia de Papel' },
            { label: 'Magia de Pedra' },
            { label: 'Magia de Pétalas de Cerejeira' },
            { label: 'Magia de Rocha' },
            { label: 'Magia de Som' },
            { label: 'Magia de Videira' },
            { label: 'Magia de Vidro' },
            { label: 'Magia Ocular' },
            { label: 'Magia de Ar' },
            { label: 'Magia de Areia' },
            { label: 'Magia de Árvore' },
            { label: 'Magia de Água' },
            { label: 'Magia de Fogo' },
            { label: 'Magia de Gelo' },
            { label: 'Magia de Neve' },
            { label: 'Magia de Plantas' },
            { label: 'Magia de Plantas Venenosas' },
            { label: 'Magia de Raio' },
            { label: 'Magia de Terra' },
            { label: 'Magia de Vento' },
        ],
    },
    {
        rarity: 'Incomum',
        items: [
            { label: 'Magia de Aço' },
            { label: 'Magia de Asa' },
            { label: 'Magia de Bronze' },
            { label: 'Magia de Bússola' },
            { label: 'Magia de Cabelo' },
            { label: 'Magia de Cobre' },
            { label: 'Magia de Correntes' },
            { label: 'Magia de Dança' },
            { label: 'Magia de Ferro' },
            { label: 'Magia de Fumaça' },
            { label: 'Magia de Fungo' },
            { label: 'Magia de Gel' },
            { label: 'Magia de Globo Ocular' },
            { label: 'Magia de Jogos' },
            { label: 'Magia de Língua' },
            { label: 'Magia de Muco' },
            { label: 'Magia de Pele' },
            { label: 'Magia de Unha' },
            { label: 'Magia de Veneno' },
        ],
    },
    {
        rarity: 'Rara',
        items: [
            { label: 'Magia de Ácido', capacity: 3 },
            { label: 'Magia de Comida', capacity: 3 },
            { label: 'Magia de Corindo', capacity: 3 },
            { label: 'Magia de Dados', capacity: 3 },
            { label: 'Magia de Manipulação Corporal', capacity: 3 },
            { label: 'Magia de Memória', capacity: 3 },
            { label: 'Magia de Mercúrio', capacity: 3 },
            { label: 'Magia de Molusco', capacity: 3 },
            { label: 'Magia de Mosquito', capacity: 3 },
            { label: 'Magia de Nuvem Negra', capacity: 3 },
            { label: 'Magia de Ocre Vermelha', capacity: 3 },
            { label: 'Magia de Pena', capacity: 3 },
            { label: 'Magia de Recombinação', capacity: 3 },
            { label: 'Magia de Shakudo', capacity: 3 },
            { label: 'Magia de Sombras', capacity: 3 },
            { label: 'Magia de Terra Preta', capacity: 3 },
            { label: 'Magia Espacial', capacity: 3 },
        ],
    },
    {
        rarity: 'Epica',
        items: [
            { label: 'Magia de Barreira', capacity: 2 },
            { label: 'Magia de Cadáver da Alma', capacity: 3 },
            { label: 'Magia de Catalisador', capacity: 2 },
            { label: 'Magia de Cunha de Gelo', capacity: 2 },
            { label: 'Magia de Feral', capacity: 2 },
            { label: 'Magia de Legião', capacity: 2 },
            { label: 'Magia de Modificação', capacity: 2 },
            { label: 'Magia de Ossos', capacity: 2 },
            { label: 'Magia de Permeação', capacity: 2 },
            { label: 'Magia de Pintura', capacity: 2 },
            { label: 'Magia de Vórtice', capacity: 2 },
        ],
    },
    {
        rarity: 'Lendaria',
        items: [
            { label: 'Magia de Árvore Mundial', capacity: 1 },
            { label: 'Magia de Balança', capacity: 1 },
            { label: 'Magia de Chave', capacity: 1 },
            { label: 'Magia de Corte', capacity: 1 },
            { label: 'Magia de Escuridão', capacity: 1 },
            { label: 'Magia de Espadas', capacity: 1 },
            { label: 'Magia de Espelhos', capacity: 1 },
            { label: 'Magia de Estrelas', capacity: 1 },
            { label: 'Magia de Fio', capacity: 1 },
            { label: 'Magia de Imitação (Cópia)', capacity: 1 },
            { label: 'Magia de Luz', capacity: 2 },
            { label: 'Magia de Luar', capacity: 1 },
            { label: 'Magia de Roseira', capacity: 1 },
            { label: 'Magia de Sangue', capacity: 1 },
            { label: 'Magia de Selo', capacity: 1 },
            { label: 'Magia de Sonhos', capacity: 1 },
            { label: 'Magia de Transmutação', capacity: 1 },
        ],
    },
];

const LEGENDARY_CAPACITY_BOOST_KEYS = new Set([
    'magia_de_balanca',
    'magia_de_corte',
    'magia_de_fio',
    'magia_de_roseira',
    'magia_de_sangue',
]);

function applyMagicCapacityUpdates() {
    for (const group of MAGIC_GROUPS) {
        for (const item of group.items) {
            if (group.rarity === 'Rara') {
                item.capacity = 4;
                continue;
            }
            if (group.rarity === 'Epica') {
                item.capacity = 3;
                continue;
            }
            if (group.rarity === 'Lendaria' && LEGENDARY_CAPACITY_BOOST_KEYS.has(getMagicSlotKey(item.label))) {
                item.capacity = 2;
            }
        }
    }
}

applyMagicCapacityUpdates();

const ALL_MAGICS = MAGIC_GROUPS.flatMap((group) => group.items.map((item) => ({
    ...item,
    rarity: group.rarity,
    key: getMagicSlotKey(item.label),
})));

function normalizeRarity(value) {
    const normalized = normalizeText(value);
    if (normalized.includes('lend')) return 'Lendaria';
    if (normalized.includes('epic')) return 'Epica';
    if (normalized.includes('rara')) return 'Rara';
    if (normalized.includes('incomum')) return 'Incomum';
    return 'Comum';
}

function getRarityMeta(rarity) {
    return RARITY_META[normalizeRarity(rarity)] || RARITY_META.Comum;
}

function getAvailableMagicGroupsForRoll(roll) {
    const capMeta = getRarityMeta(roll.magic_rarity);
    return MAGIC_GROUPS.filter((group) => RARITY_META[group.rarity].level <= capMeta.level);
}

function getAvailableMagicsForRoll(roll) {
    return getAvailableMagicGroupsForRoll(roll).flatMap((group) => group.items.map((item) => ({
        ...item,
        rarity: group.rarity,
        key: getMagicSlotKey(item.label),
    })));
}

function getAllMagics() {
    return ALL_MAGICS.map((item) => ({ ...item }));
}

function getBestRollForMagicPrompt(rolls, selectedRollNumber = null) {
    const selected = rolls.find((roll) => Number(roll.roll_number) === Number(selectedRollNumber));
    if (selected) return selected;

    return [...rolls].sort((a, b) => {
        const rarityDiff = getRarityMeta(b.magic_rarity).level - getRarityMeta(a.magic_rarity).level;
        if (rarityDiff !== 0) return rarityDiff;
        return Number(a.roll_number) - Number(b.roll_number);
    })[0] || null;
}

function getRollsMatchingMagic(rolls, magicLabel) {
    const option = findMagicOption(ALL_MAGICS, magicLabel);
    if (!option) return [];

    const requiredLevel = getRarityMeta(option.rarity).level;
    return rolls.filter((roll) => getRarityMeta(roll.magic_rarity).level >= requiredLevel);
}

function normalizeMagicLabel(label) {
    return normalizeText(label);
}

function normalizeMagicSearch(label) {
    return normalizeMagicLabel(String(label || '').replace(/_/g, ' '))
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeMagicCore(label) {
    return normalizeMagicSearch(label)
        .replace(/^magia\s+(de|da|do|das|dos)\s+/, '')
        .replace(/^magia\s+/, '')
        .trim();
}

function isDisabledMagicInput(input) {
    const normalizedInput = normalizeMagicSearch(input);
    const coreInput = normalizeMagicCore(input);
    return normalizedInput === 'magia da alma' || coreInput === 'alma';
}

function getMagicSearchTerms(magic) {
    const terms = new Set();
    [magic?.label, magic?.name, magic?.key].filter(Boolean).forEach((value) => {
        const full = normalizeMagicSearch(value);
        const core = normalizeMagicCore(value);
        if (full) terms.add(full);
        if (core) terms.add(core);
    });
    return [...terms];
}

function getMagicSlotKey(label) {
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
}

async function getMagicUsageMap(db, excludePlayerId = null) {
    const usage = new Map();
    for (const rawOption of ALL_MAGICS) {
        const option = withCanonicalMagicCapacity(rawOption);
        if (!option.capacity) continue;
        const usedCount = await countUsedSlots(db, 'magic', option.key, { excludePlayerId });
        usage.set(normalizeMagicLabel(option.label), usedCount);
    }
    return usage;
}

async function purgeExpiredMagicConfirmations(db) {
    await expireOldReservations(db);
    await db.run(`
        DELETE FROM pending_magic_confirmations
        WHERE created_at < datetime('now', '-1 hours')
    `);
}

async function savePendingMagicConfirmation(db, playerId, magicLabel, rollNumber = null) {
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
            `INSERT INTO pending_magic_confirmations (player_id, magic_label, roll_number, created_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(player_id) DO UPDATE SET
                 magic_label = excluded.magic_label,
                 roll_number = excluded.roll_number,
                 created_at = CURRENT_TIMESTAMP`,
            [playerId, option.label, rollNumber]
        );
    } catch (error) {
        if (option.capacity) await releaseReservation(db, playerId, 'magic', option.key).catch(() => null);
        throw error;
    }

    return { ok: true, reservation };
}

async function getPendingMagicConfirmation(db, playerId) {
    await purgeExpiredMagicConfirmations(db);
    const row = await db.get(
        `SELECT player_id, magic_label, roll_number, created_at
         FROM pending_magic_confirmations
         WHERE player_id = ?`,
        [playerId]
    );
    return row || null;
}

async function clearPendingMagicConfirmation(db, playerId) {
    const pending = await getPendingMagicConfirmation(db, playerId);
    if (pending) {
        const option = withCanonicalMagicCapacity(
            ALL_MAGICS.find((item) => normalizeMagicLabel(item.label) === normalizeMagicLabel(pending.magic_label))
        );
        if (option?.capacity) await releaseReservation(db, playerId, 'magic', option.key);
    }

    await db.run('DELETE FROM pending_magic_confirmations WHERE player_id = ?', [playerId]);
}

async function confirmPendingMagicChoice(db, playerId) {
    const pending = await getPendingMagicConfirmation(db, playerId);
    if (!pending) return { ok: false, reason: 'missing_pending' };

    const availability = await getMagicAvailability(db, pending.magic_label, playerId);
    if (!availability || !availability.available) {
        await clearPendingMagicConfirmation(db, playerId);
        return { ok: false, reason: 'unavailable', availability };
    }

    if (availability.option.capacity) {
        const confirmedReservation = await occupySlot(
            db,
            playerId,
            'magic',
            getMagicSlotKey(availability.option.label),
            'magic_choice',
            pending.roll_number
        );

        if (!confirmedReservation.ok) {
            await clearPendingMagicConfirmation(db, playerId);
            return { ok: false, reason: 'reservation_expired', availability };
        }
    }

    const player = await db.get('SELECT numero_roll_escolhido, ficha_status FROM jogadores WHERE id = ?', [playerId]);
    const selectedRollNumber = pending.roll_number || player?.numero_roll_escolhido || null;
    const currentStatus = player?.ficha_status || 'incompleta';
    const nextStatus = ['confirmada', 'aprovada'].includes(currentStatus) ? 'aprovada' : currentStatus;

    await db.run('UPDATE jogadores SET magia = ?, magia_key = ?, ficha_status = ?, numero_roll_escolhido = COALESCE(?, numero_roll_escolhido) WHERE id = ?', [
        availability.option.label,
        getMagicSlotKey(availability.option.label),
        nextStatus,
        selectedRollNumber,
        playerId,
    ]);

    await clearPendingMagicConfirmation(db, playerId);

    return {
        ok: true,
        availability: await getMagicAvailability(db, availability.option.label, null),
        profileComplete: nextStatus === 'aprovada',
        selectedRollNumber,
    };
}

async function setSelectedRollForMagic(db, playerId, rollNumber) {
    await db.run('UPDATE jogadores SET numero_roll_escolhido = ? WHERE id = ?', [rollNumber, playerId]);
}

function formatMagicSlot(option, usedCount) {
    if (!option.capacity) return 'Livre';
    return `(${usedCount}/${option.capacity})`;
}

async function getMagicAvailability(db, magicLabel, excludePlayerId = null) {
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
}

function isMagicAllowedForRoll(option, roll) {
    return getRarityMeta(option.rarity).level <= getRarityMeta(roll.magic_rarity).level;
}

function renderMagicLine(rawOption, usedCount, roll = null) {
    const option = withCanonicalMagicCapacity(rawOption);
    const full = Boolean(option.capacity && usedCount >= option.capacity);
    const slotSuffix = option.capacity ? ` *(${usedCount}/${option.capacity})*` : '';
    const stateSuffix = full
        ? ' · esgotada'
        : roll
            ? isMagicAllowedForRoll(option, roll) ? ' · disponível' : ' · acima do roll'
            : '';
    return `﹒ ${option.label}${slotSuffix}${stateSuffix}`;
}

async function renderMagicChoicePrompt(db, roll, options = null) {
    const availableOptions = options || ALL_MAGICS;
    const usageMap = await getMagicUsageMap(db);
    const capMeta = getRarityMeta(roll.magic_rarity);
    const lines = [
        '.',
        '     ──  𝐌𝐀𝐆𝐈𝐀𝐒 𝐃𝐈𝐒𝐏𝐎𝐍𝐈́𝐕𝐄𝐈𝐒 ──',
        '',
        '*♡  Escolhα suα mαgıα com cαlmα.*',
        '',
        `↳ *Rαrıdαdᥱ do sᥱu roll:* ${capMeta.emoji} *${capMeta.label}*`,
        '↳ A lıstα mostrα todαs αs mαgıαs; αs dᥱ rαrıdαdᥱ αcımα do roll fıcαm bloquᥱαdαs.',
        `↳ Rᥱspondα ᥱstα mᥱnsαgᥱm com o *nomᥱ dα mαgıα* ou com o nomᥱ prıncıpαl.`,
        '↳ Se mais de um roll servir, eu vou pedir o numero antes de confirmar.',
    ];

    if (!availableOptions.length) {
        lines.push('↳ Nᥱnhumα mαgıα foı lıstαdα pαrα ᥱssᥱ roll.');
        return lines.join('\n');
    }

    MAGIC_GROUPS.forEach((group) => {
        const meta = getRarityMeta(group.rarity);
        lines.push('');
        lines.push('.');
        lines.push(`     ──  𝐂𝐋𝐀𝐒𝐒𝐄 ${meta.headerLabel}  ${meta.emoji} ──`);
        lines.push('');

        group.items.forEach((item) => {
            const option = withCanonicalMagicCapacity({
                ...item,
                rarity: group.rarity,
                key: getMagicSlotKey(item.label),
            });
            const usedCount = usageMap.get(normalizeMagicLabel(option.label)) || 0;
            lines.push(renderMagicLine(option, usedCount, roll));
        });
    });

    return lines.join('\n');
}

function findMagicOptions(options, input) {
    if (!input) return [];
    if (isDisabledMagicInput(input)) return [];

    const normalizedInput = normalizeMagicSearch(input);
    const coreInput = normalizeMagicCore(input);
    if (!normalizedInput && !coreInput) return [];

    const exactMatches = options.filter((magic) => {
        const terms = getMagicSearchTerms(magic);
        return terms.includes(normalizedInput) || terms.includes(coreInput);
    });
    if (exactMatches.length) return exactMatches;
    if (!coreInput) return [];

    const startMatches = options.filter((magic) => getMagicSearchTerms(magic)
        .some((term) => term.startsWith(coreInput)));
    if (startMatches.length) return startMatches;

    return options.filter((magic) => getMagicSearchTerms(magic)
        .some((term) => term.includes(coreInput)));
}

function findMagicOption(options, input) {
    const matches = findMagicOptions(options, input);
    return matches.length ? matches[0] : null;
}

function renderMagicAmbiguousMessage(input, matches) {
    const limitedMatches = matches.slice(0, 8);
    return [
        '.',
        '     ──  MAGIA PARECIDA  ──',
        '',
        `Encontrei mais de uma opcao para *${String(input || '').trim()}*.`,
        '',
        ...limitedMatches.map((magic) => `• ${magic.label}`),
        matches.length > limitedMatches.length ? `• ...e mais ${matches.length - limitedMatches.length}` : '',
        '',
        'Responda de novo com o nome mais completo da magia.',
    ].filter(Boolean).join('\n');
}

function renderMagicRarityBlockedMessage(choice, roll) {
    const magicMeta = getRarityMeta(choice.rarity);
    const rollMeta = getRarityMeta(roll.magic_rarity);
    return [
        '.',
        '     ──  MAGIA BLOQUEADA  ──',
        '',
        `*${choice.label}* e ${magicMeta.label}, mas seu roll libera ate ${rollMeta.label}.`,
        '',
        `Use *${COMMAND_PREFIX}magias* para escolher uma magia de raridade igual ou inferior ao roll.`,
        `Se travar, use *${COMMAND_PREFIX}continuar*.`,
    ].join('\n');
}

function renderMagicNotFoundMessage(input, roll) {
    const suggestions = getClosestTextMatches(input, ALL_MAGICS);
    return [
        '.',
        '     ──  MAGIA NAO ENCONTRADA  ──',
        '',
        `Nao encontrei *${String(input || '').trim()}* na lista de magias.`,
        suggestions.length ? `Opcoes proximas: ${suggestions.join(', ')}.` : '',
        '',
        `Use *${COMMAND_PREFIX}magias* para ver a lista completa.`,
        roll ? `Raridade do roll atual: *${getRarityMeta(roll.magic_rarity).label}*.` : '',
    ].filter(Boolean).join('\n');
}

function renderMagicPreviewMessage(availability) {
    const meta = getRarityMeta(availability.option.rarity);
    return [
        '.',
        '     ──  𝐏𝐑𝐄́𝐕𝐈𝐀 𝐃𝐄 𝐌𝐀𝐆𝐈𝐀  ──',
        '',
        '*♡  Essα mαgıα combınα com o sᥱu roll.*',
        '',
        `↳ *Mαgıα* · ${availability.option.label}`,
        `↳ *Clαssᥱ* · ${meta.emoji} ${meta.label}`,
        `↳ *Vαgα αtuαl* · ${availability.slotText}`,
        `↳ Quαndo α ᥱtαpα fınαl for lıbᥱrαdα, use *${COMMAND_PREFIX}magias* e responda a lista.`,
    ].join('\n');
}

function renderMagicNeedsRollMessage() {
    return [
        '.',
        '     ──  𝐌𝐀𝐆𝐈𝐀𝐒  ──',
        '',
        '*♡  Voce ainda nao tem roll salvo para escolher magia.*',
        '',
        `↳ Use *${COMMAND_PREFIX}sortear* primeiro.`,
        `↳ Com pelo menos 1 roll, voce ja pode usar *${COMMAND_PREFIX}magias*.`,
    ].join('\n');
}

function renderMagicRollChoiceMessage(choice, rolls) {
    const lines = [
        '.',
        '     ──  𝐑𝐎𝐋𝐋 𝐃𝐀 𝐌𝐀𝐆𝐈𝐀  ──',
        '',
        '*♡  Essa magia combina com mais de um dos seus rolls.*',
        '',
        `↳ *Magia* · ${choice.label}`,
        '',
        'Escolha qual roll vai ficar vinculado a ela:',
        '',
    ];

    rolls.forEach((roll) => {
        const meta = getRarityMeta(roll.magic_rarity);
        lines.push(`#${String(roll.roll_number).padStart(2, '0')} · ${roll.kingdom} · ${meta.emoji} ${meta.label}`);
    });

    lines.push('');
    lines.push('↳ Responda so com o numero do roll.');
    lines.push('↳ Para desistir, responda `cancelar`.');

    return lines.join('\n');
}

function renderMagicConfirmationMessage(availability, roll = null) {
    const meta = getRarityMeta(availability.option.rarity);
    const lines = [
        '.',
        '     ──  𝐂𝐎𝐍𝐅𝐈𝐑𝐌𝐀𝐂̧𝐀̃𝐎  ──',
        '',
        `*♡  Você ᥱscolhᥱu:* *${availability.option.label}*`,
        '',
        `↳ *Clαssᥱ* · ${meta.emoji} ${meta.label}`,
        `↳ *Vαgα αtuαl* · ${availability.slotText}`,
    ];

    if (roll) {
        const rollMeta = getRarityMeta(roll.magic_rarity);
        lines.push(`↳ *Roll vınculαdo* · #${String(roll.roll_number).padStart(2, '0')} ${roll.kingdom} ${rollMeta.emoji} ${rollMeta.label}`);
    }

    lines.push('↳ Essα ᥱscolhα ficα pᥱndᥱntᥱ por *1h*.');
    lines.push('↳ A vαgα só fᥱchα dᥱ vᥱrdαdᥱ quαndo você rᥱspondᥱr *confirmar*.');
    lines.push('');
    lines.push('_Bαstα rᥱspondᥱr com `confirmar` ou `cancelar`._');

    return lines.join('\n');
}

function renderMagicCancelledMessage() {
    return [
        '.',
        '     ──  𝐌𝐀𝐆𝐈𝐀 𝐂𝐀𝐍𝐂𝐄𝐋𝐀𝐃𝐀  ──',
        '',
        '*♡  Tudo bᥱm. Suα ᥱscolhα foı cαncᥱlαdα.*',
        '',
        `↳ Use *${COMMAND_PREFIX}magias* pαrα vᥱr α lıstα novαmᥱntᥱ.`,
    ].join('\n');
}

function isMagicFlowCriticalStep(step) {
    return ['escolha_roll_magia', 'confirmar_magia'].includes(step);
}

function renderMagicFlowLockedMessage() {
    return [
        '.',
        '     ──  𝐌𝐀𝐆𝐈𝐀 𝐏𝐄𝐍𝐃𝐄𝐍𝐓𝐄  ──',
        '',
        '*♡  Antes de seguir, finalize sua escolha de magia.*',
        '',
        '↳ Responda com o numero do roll quando eu pedir.',
        '↳ Ou responda `confirmar` / `cancelar` quando estiver na confirmacao.',
        `↳ Para cancelar por comando, use *${COMMAND_PREFIX}cancelarmagia*.`,
    ].join('\n');
}

function renderMagicNothingToCancelMessage() {
    return [
        '.',
        '     ──  𝐌𝐀𝐆𝐈𝐀  ──',
        '',
        '*♡  Nao encontrei magia pendente para cancelar.*',
        '',
        `↳ Se quiser escolher uma, use *${COMMAND_PREFIX}magias*.`,
    ].join('\n');
}

function renderMagicUnavailableMessage() {
    return [
        '.',
        '     ──  𝐌𝐀𝐆𝐈𝐀 𝐈𝐍𝐃𝐈𝐒𝐏𝐎𝐍𝐈́𝐕𝐄𝐋  ──',
        '',
        '*♡  Essa magia nao tem vagas disponiveis no momento.*',
        '',
        `↳ Use *${COMMAND_PREFIX}magias* para escolher outra.`,
    ].join('\n');
}

function renderMagicLockedByProfileMessage() {
    return [
        '.',
        '     ──  𝐌𝐀𝐆𝐈𝐀 𝐃𝐄𝐅𝐈𝐍𝐈𝐃𝐀  ──',
        '',
        '*♡  Sua magia ja esta vinculada a ficha.*',
        '',
        '↳ Para trocar depois da ficha fechada, chame a administracao.',
    ].join('\n');
}

function renderMagicChosenMessage(availability, { roll = null, profileComplete = true } = {}) {
    const meta = getRarityMeta(availability.option.rarity);
    const lines = [
        '.',
        '     ──  𝐌𝐀𝐆𝐈𝐀 𝐃𝐄𝐅𝐈𝐍𝐈𝐃𝐀  ──',
        '',
        '*♡  Suα mαgıα foı escolhıdα com succᥱsso.*',
        '',
        `↳ *Mαgıα* · ${availability.option.label}`,
        `↳ *Clαssᥱ* · ${meta.emoji} ${meta.label}`,
        `↳ *Vαgαs αgorα* · ${availability.slotText}`,
    ];

    if (roll) {
        const rollMeta = getRarityMeta(roll.magic_rarity);
        lines.push(`↳ *Roll vınculαdo* · #${String(roll.roll_number).padStart(2, '0')} ${roll.kingdom} ${rollMeta.emoji} ${rollMeta.label}`);
    }

    lines.push('');
    if (profileComplete) {
        lines.push('↳ Sᥱu cαdαstro ᥱstά concluído.');
        lines.push(`↳ Use *${COMMAND_PREFIX}ficha* ou *${COMMAND_PREFIX}perfil* quαndo quısᥱr rᥱvᥱr os dαdos.`);
    } else {
        lines.push(`↳ Suα mαgıα jά ficou sαlvα. Agorα fᥱchᥱ suα fıchα com *${COMMAND_PREFIX}ficha*.`);
        lines.push(`↳ Para trocar depois, use *${COMMAND_PREFIX}magias* e siga a nova confirmacao.`);
    }

    return lines.join('\n');
}

module.exports = {
    clearPendingMagicConfirmation,
    confirmPendingMagicChoice,
    findMagicOption,
    findMagicOptions,
    getAllMagics,
    getAvailableMagicsForRoll,
    getMagicAvailability,
    getBestRollForMagicPrompt,
    getMagicSlotKey,
    getPendingMagicConfirmation,
    getRarityMeta,
    getRollsMatchingMagic,
    isMagicFlowCriticalStep,
    renderMagicCancelledMessage,
    renderMagicAmbiguousMessage,
    renderMagicChoicePrompt,
    renderMagicChosenMessage,
    renderMagicConfirmationMessage,
    renderMagicFlowLockedMessage,
    renderMagicLockedByProfileMessage,
    renderMagicNeedsRollMessage,
    renderMagicNothingToCancelMessage,
    renderMagicNotFoundMessage,
    renderMagicPreviewMessage,
    renderMagicRarityBlockedMessage,
    renderMagicRollChoiceMessage,
    renderMagicUnavailableMessage,
    savePendingMagicConfirmation,
    setSelectedRollForMagic,
};
