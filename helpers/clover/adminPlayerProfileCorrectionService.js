'use strict';

const { normalizeText } = require('../textUtils');
const {
    getAllMagics,
    getMagicAvailability,
    getMagicSlotKey,
} = require('../magicManager');
const { loadCloverConfigs } = require('./configLoader');
const {
    canReserve,
    occupySlotInTransaction,
    releasePlayerCategorySlotsExcept,
} = require('./slotManager');

class AdminPlayerProfileCorrectionError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminPlayerProfileCorrectionError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function optionalText(value, maximum = 180) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    if (!text) return null;
    return text.slice(0, maximum);
}

function comparableText(value) {
    return normalizeText(String(value || ''))
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function findConfigOption(list, value) {
    const input = optionalText(value, 180);
    if (!input) return null;
    const normalized = comparableText(input);
    return (list || []).find((option) => (
        String(option.key || '').trim().toLowerCase() === input.toLowerCase()
        || comparableText(option.name) === normalized
    )) || null;
}

function normalizeMagicInput(value) {
    const input = optionalText(value, 180);
    if (!input) return null;
    const normalized = normalizeText(input);
    const magics = getAllMagics();
    const exact = magics.find((magic) => (
        String(magic.key || '').trim().toLowerCase() === input.toLowerCase()
        || normalizeText(magic.label || magic.name) === normalized
    ));
    return exact || null;
}

function normalizeRaceInput(value) {
    return findConfigOption(loadCloverConfigs().lists.races, value);
}

function normalizeGrimoireInput(value) {
    return findConfigOption(loadCloverConfigs().lists.grimoires, value);
}

function normalizeSocialClassInput(value) {
    return findConfigOption(loadCloverConfigs().lists.socialClasses, value);
}

function normalizeKingdomInput(value) {
    return findConfigOption(loadCloverConfigs().lists.kingdoms, value);
}

function normalizedOption(option, extras = {}) {
    if (!option) return null;
    return {
        key: option.key,
        label: option.name,
        capacity: option.capacity ?? null,
        ...extras,
    };
}

function normalizeProfileCorrectionPayload(payload = {}) {
    const characterName = optionalText(
        payload.characterName
        ?? payload.character_name
        ?? payload.personagemNome
        ?? payload.personagem_nome,
        120
    );

    const rawMagic = payload.magicKey
        ?? payload.magic_key
        ?? payload.magic
        ?? payload.magia
        ?? null;
    const rawRace = payload.raceKey
        ?? payload.race_key
        ?? payload.race
        ?? payload.raca
        ?? null;
    const rawGrimoire = payload.grimoireKey
        ?? payload.grimoire_key
        ?? payload.grimoire
        ?? payload.grimorio
        ?? null;
    const rawSocialClass = payload.socialClassKey
        ?? payload.social_class_key
        ?? payload.socialClass
        ?? payload.classKey
        ?? payload.className
        ?? payload.classe
        ?? null;

    const magic = rawMagic === null || rawMagic === undefined || String(rawMagic).trim() === ''
        ? null
        : normalizeMagicInput(rawMagic);
    const race = rawRace === null || rawRace === undefined || String(rawRace).trim() === ''
        ? null
        : normalizeRaceInput(rawRace);
    const grimoire = rawGrimoire === null || rawGrimoire === undefined || String(rawGrimoire).trim() === ''
        ? null
        : normalizeGrimoireInput(rawGrimoire);
    const socialClass = rawSocialClass === null || rawSocialClass === undefined || String(rawSocialClass).trim() === ''
        ? null
        : normalizeSocialClassInput(rawSocialClass);

    if (!characterName && !rawMagic && !rawRace && !rawGrimoire && !rawSocialClass) {
        throw new AdminPlayerProfileCorrectionError(
            'empty_profile_correction',
            'Informe ao menos Nome, Magia, Raça, Grimório ou Classe Social para corrigir.',
            400
        );
    }
    if (rawMagic && !magic) {
        throw new AdminPlayerProfileCorrectionError(
            'magic_not_found',
            'A Magia informada não existe no catálogo canônico.',
            400,
            { input: String(rawMagic) }
        );
    }
    if (rawRace && !race) {
        throw new AdminPlayerProfileCorrectionError(
            'race_not_found',
            'A Raça informada não existe no catálogo canônico.',
            400,
            { input: String(rawRace) }
        );
    }
    if (rawGrimoire && !grimoire) {
        throw new AdminPlayerProfileCorrectionError(
            'grimoire_not_found',
            'O Grimório informado não existe no catálogo canônico.',
            400,
            { input: String(rawGrimoire) }
        );
    }
    if (rawSocialClass && !socialClass) {
        throw new AdminPlayerProfileCorrectionError(
            'social_class_not_found',
            'A Classe Social informada não existe no catálogo canônico.',
            400,
            { input: String(rawSocialClass) }
        );
    }

    return {
        ...(characterName ? { characterName } : {}),
        ...(magic ? {
            magic: {
                key: magic.key || getMagicSlotKey(magic.label),
                label: magic.label || magic.name,
                rarity: magic.rarity || null,
            },
        } : {}),
        ...(race ? {
            race: normalizedOption(race),
        } : {}),
        ...(grimoire ? {
            grimoire: normalizedOption(grimoire, {
                kingdomKey: grimoire.kingdomKey || null,
                rank: grimoire.rank || null,
                symbol: grimoire.symbol || null,
            }),
        } : {}),
        ...(socialClass ? {
            socialClass: normalizedOption(socialClass),
        } : {}),
    };
}

function inferProfileOption(kind, label) {
    if (!label || String(label).trim() === '-' || comparableText(label) === 'n a') return null;
    if (kind === 'race') return normalizeRaceInput(label);
    if (kind === 'grimoire') return normalizeGrimoireInput(label);
    if (kind === 'socialClass') return normalizeSocialClassInput(label);
    if (kind === 'kingdom') return normalizeKingdomInput(label);
    return null;
}

async function readProfileSnapshot(db, playerId) {
    const row = await db.get(
        `SELECT id, personagem_nome, magia, magia_key, reino, classe, raca, grimorio,
                numero_roll_escolhido, ficha_status
         FROM jogadores
         WHERE id = ?`,
        [playerId]
    );
    if (!row) {
        throw new AdminPlayerProfileCorrectionError(
            'player_not_found',
            'Jogador não encontrado.',
            404,
            { playerId }
        );
    }

    const race = inferProfileOption('race', row.raca);
    const grimoire = inferProfileOption('grimoire', row.grimorio);
    const socialClass = inferProfileOption('socialClass', row.classe);
    const kingdom = inferProfileOption('kingdom', row.reino);

    return {
        playerId: String(row.id),
        characterName: row.personagem_nome || '-',
        magicLabel: row.magia || null,
        magicKey: row.magia_key || null,
        kingdomLabel: row.reino || null,
        kingdomKey: kingdom?.key || null,
        raceLabel: row.raca || null,
        raceKey: race?.key || null,
        grimoireLabel: row.grimorio || null,
        grimoireKey: grimoire?.key || null,
        classLabel: row.classe || null,
        classKey: socialClass?.key || null,
        selectedRollNumber: row.numero_roll_escolhido ?? null,
        profileStatus: row.ficha_status || null,
    };
}

function sameSnapshot(left, right) {
    return String(left?.characterName || '-') === String(right?.characterName || '-')
        && String(left?.magicLabel || '') === String(right?.magicLabel || '')
        && String(left?.magicKey || '') === String(right?.magicKey || '')
        && String(left?.kingdomLabel || '') === String(right?.kingdomLabel || '')
        && String(left?.kingdomKey || '') === String(right?.kingdomKey || '')
        && String(left?.raceLabel || '') === String(right?.raceLabel || '')
        && String(left?.raceKey || '') === String(right?.raceKey || '')
        && String(left?.grimoireLabel || '') === String(right?.grimoireLabel || '')
        && String(left?.grimoireKey || '') === String(right?.grimoireKey || '')
        && String(left?.classLabel || '') === String(right?.classLabel || '')
        && String(left?.classKey || '') === String(right?.classKey || '');
}

async function assertSnapshot(db, playerId, expected, code) {
    const current = await readProfileSnapshot(db, playerId);
    if (!sameSnapshot(current, expected)) {
        throw new AdminPlayerProfileCorrectionError(
            code,
            'O perfil mudou depois da prévia. Gere uma nova operação.',
            409,
            { expected, current }
        );
    }
    return current;
}

async function assertMagicAvailable(db, playerId, magic) {
    const availability = await getMagicAvailability(db, magic.label, playerId);
    if (!availability) {
        throw new AdminPlayerProfileCorrectionError(
            'magic_not_found',
            'A Magia não existe no catálogo canônico.',
            400,
            { magicKey: magic.key }
        );
    }
    if (!availability.available) {
        throw new AdminPlayerProfileCorrectionError(
            'magic_capacity_full',
            'A Magia escolhida está sem vagas disponíveis.',
            409,
            {
                magicKey: magic.key,
                capacity: availability.capacity,
                usedCount: availability.usedCount,
            }
        );
    }
    return availability;
}

async function assertSlotAvailable(db, playerId, category, option) {
    if (!option) return null;
    const availability = await canReserve(db, category, option.key, {
        excludePlayerId: playerId,
    });
    if (!availability.available) {
        const labels = { race: 'Raça', grimoire: 'Grimório' };
        throw new AdminPlayerProfileCorrectionError(
            `${category}_capacity_full`,
            `${labels[category] || category} escolhido está sem vagas disponíveis.`,
            409,
            {
                optionKey: option.key,
                capacity: availability.capacity,
                usedCount: availability.usedCount,
            }
        );
    }
    return availability;
}

function validateFinalProfileState(before, correction) {
    const finalRaceKey = correction.race?.key || before.raceKey;
    const finalClassKey = correction.socialClass?.key || before.classKey;
    const finalGrimoire = correction.grimoire || (
        before.grimoireKey
            ? normalizedOption(normalizeGrimoireInput(before.grimoireKey), {
                kingdomKey: normalizeGrimoireInput(before.grimoireKey)?.kingdomKey || null,
            })
            : null
    );

    const currentRaceMeaningful = before.raceLabel
        && String(before.raceLabel).trim() !== '-'
        && comparableText(before.raceLabel) !== 'n a';
    const currentGrimoireMeaningful = before.grimoireLabel
        && String(before.grimoireLabel).trim() !== '-';

    if ((correction.race || correction.socialClass) && currentRaceMeaningful && !before.raceKey) {
        throw new AdminPlayerProfileCorrectionError(
            'current_race_not_canonical',
            'A Raça atual não pôde ser reconciliada com o catálogo. Corrija a identidade antes de trocar a Raça.',
            409,
            { current: before.raceLabel }
        );
    }
    if (correction.grimoire && currentGrimoireMeaningful && !before.grimoireKey) {
        throw new AdminPlayerProfileCorrectionError(
            'current_grimoire_not_canonical',
            'O Grimório atual não pôde ser reconciliado com o catálogo. Corrija a identidade antes de trocá-lo.',
            409,
            { current: before.grimoireLabel }
        );
    }

    if (
        correction.grimoire
        && finalGrimoire?.kingdomKey
        && before.kingdomKey
        && finalGrimoire.kingdomKey !== before.kingdomKey
    ) {
        throw new AdminPlayerProfileCorrectionError(
            'grimoire_kingdom_mismatch',
            'O Grimório escolhido pertence a outro Reino. Esta correção não altera Reino.',
            409,
            {
                kingdomKey: before.kingdomKey,
                grimoireKingdomKey: finalGrimoire.kingdomKey,
            }
        );
    }

    if (!correction.race && !correction.socialClass) {
        return { forceClassNotApplicable: false };
    }

    if (finalRaceKey && finalRaceKey !== 'humano') {
        if (correction.socialClass) {
            throw new AdminPlayerProfileCorrectionError(
                'social_class_not_applicable',
                'Classe Social só se aplica a personagem Humano.',
                409,
                { raceKey: finalRaceKey }
            );
        }
        return { forceClassNotApplicable: Boolean(correction.race) };
    }

    if (finalRaceKey === 'humano' && !finalClassKey) {
        throw new AdminPlayerProfileCorrectionError(
            'social_class_required_for_human',
            'Personagem Humano precisa de Classe Social canônica.',
            409
        );
    }

    return { forceClassNotApplicable: false };
}

async function applyMagicInTransaction(db, playerId, magic, selectedRollNumber, source) {
    await assertMagicAvailable(db, playerId, magic);
    const occupied = await occupySlotInTransaction(
        db,
        playerId,
        'magic',
        magic.key,
        source,
        selectedRollNumber
    );
    if (!occupied?.ok) {
        throw new AdminPlayerProfileCorrectionError(
            'magic_capacity_full',
            'A vaga da Magia foi ocupada antes da aplicação.',
            409,
            occupied || null
        );
    }
    await releasePlayerCategorySlotsExcept(db, playerId, 'magic', magic.key);
    return occupied;
}

async function applyCanonicalSlotInTransaction(db, playerId, category, option, selectedRollNumber, source) {
    if (!option?.key) {
        await releasePlayerCategorySlotsExcept(db, playerId, category, null);
        return null;
    }
    const occupied = await occupySlotInTransaction(
        db,
        playerId,
        category,
        option.key,
        source,
        selectedRollNumber
    );
    if (!occupied?.ok) {
        throw new AdminPlayerProfileCorrectionError(
            `${category}_capacity_full`,
            'A vaga foi ocupada antes da aplicação.',
            409,
            occupied || null
        );
    }
    await releasePlayerCategorySlotsExcept(db, playerId, category, option.key);
    return occupied;
}

function snapshotOption(kind, snapshot) {
    if (kind === 'race') {
        return snapshot.raceKey ? normalizedOption(normalizeRaceInput(snapshot.raceKey)) : null;
    }
    if (kind === 'grimoire') {
        const option = snapshot.grimoireKey ? normalizeGrimoireInput(snapshot.grimoireKey) : null;
        return option ? normalizedOption(option, {
            kingdomKey: option.kingdomKey || null,
            rank: option.rank || null,
            symbol: option.symbol || null,
        }) : null;
    }
    if (kind === 'socialClass') {
        return snapshot.classKey ? normalizedOption(normalizeSocialClassInput(snapshot.classKey)) : null;
    }
    return null;
}

function createPlayerProfileCorrectionExecutors() {
    return {
        'player.profile.correct': {
            async preview({ db, action, target }) {
                const before = await readProfileSnapshot(db, target.playerId);
                const correction = normalizeProfileCorrectionPayload(action.payload || {});
                const compatibility = validateFinalProfileState(before, correction);
                const after = {
                    ...before,
                    ...(correction.characterName ? { characterName: correction.characterName } : {}),
                    ...(correction.magic ? {
                        magicLabel: correction.magic.label,
                        magicKey: correction.magic.key,
                    } : {}),
                    ...(correction.race ? {
                        raceLabel: correction.race.label,
                        raceKey: correction.race.key,
                    } : {}),
                    ...(correction.grimoire ? {
                        grimoireLabel: correction.grimoire.label,
                        grimoireKey: correction.grimoire.key,
                    } : {}),
                    ...(correction.socialClass ? {
                        classLabel: correction.socialClass.label,
                        classKey: correction.socialClass.key,
                    } : {}),
                    ...(compatibility.forceClassNotApplicable ? {
                        classLabel: 'N/A',
                        classKey: null,
                    } : {}),
                };

                if (correction.magic && correction.magic.key !== before.magicKey) {
                    await assertMagicAvailable(db, target.playerId, correction.magic);
                }
                if (correction.race && correction.race.key !== before.raceKey) {
                    await assertSlotAvailable(db, target.playerId, 'race', correction.race);
                }
                if (correction.grimoire && correction.grimoire.key !== before.grimoireKey) {
                    await assertSlotAvailable(db, target.playerId, 'grimoire', correction.grimoire);
                }

                return {
                    summary: `${target.characterName || target.playerId}: corrigir dados-base do personagem`,
                    before,
                    after,
                    metadata: {
                        fields: [
                            ...(correction.characterName ? ['characterName'] : []),
                            ...(correction.magic ? ['magic'] : []),
                            ...(correction.race ? ['race'] : []),
                            ...(correction.grimoire ? ['grimoire'] : []),
                            ...(correction.socialClass || compatibility.forceClassNotApplicable ? ['socialClass'] : []),
                        ],
                        magic: correction.magic || null,
                        race: correction.race || null,
                        grimoire: correction.grimoire || null,
                        socialClass: correction.socialClass || null,
                    },
                };
            },

            async apply({ db, operation, action, target, before, after }) {
                await assertSnapshot(db, target.playerId, before, 'profile_changed_after_preview');
                const correction = normalizeProfileCorrectionPayload(action.payload || {});
                validateFinalProfileState(before, correction);

                if (correction.magic && correction.magic.key !== before.magicKey) {
                    await applyMagicInTransaction(
                        db,
                        target.playerId,
                        correction.magic,
                        before.selectedRollNumber,
                        `admin_profile_correct:${operation.code}`
                    );
                }
                if (correction.race && correction.race.key !== before.raceKey) {
                    await applyCanonicalSlotInTransaction(
                        db,
                        target.playerId,
                        'race',
                        correction.race,
                        before.selectedRollNumber,
                        `admin_profile_correct:${operation.code}`
                    );
                }
                if (correction.grimoire && correction.grimoire.key !== before.grimoireKey) {
                    await applyCanonicalSlotInTransaction(
                        db,
                        target.playerId,
                        'grimoire',
                        correction.grimoire,
                        before.selectedRollNumber,
                        `admin_profile_correct:${operation.code}`
                    );
                }

                await db.run(
                    `UPDATE jogadores
                     SET personagem_nome = ?, magia = ?, magia_key = ?, raca = ?, grimorio = ?, classe = ?
                     WHERE id = ?`,
                    [
                        after.characterName,
                        after.magicLabel,
                        after.magicKey,
                        after.raceLabel,
                        after.grimoireLabel,
                        after.classLabel,
                        target.playerId,
                    ]
                );

                const current = await readProfileSnapshot(db, target.playerId);
                return {
                    before,
                    after: current,
                    summary: `${current.characterName}: dados-base corrigidos.`,
                };
            },

            async undo({ db, operation, target, before, after }) {
                await assertSnapshot(db, target.playerId, after, 'profile_changed_since_apply');

                const previousMagic = before.magicKey
                    ? normalizeMagicInput(before.magicKey)
                    : before.magicLabel
                        ? normalizeMagicInput(before.magicLabel)
                        : null;
                if (previousMagic) {
                    await applyMagicInTransaction(
                        db,
                        target.playerId,
                        {
                            key: previousMagic.key || getMagicSlotKey(previousMagic.label),
                            label: previousMagic.label || previousMagic.name,
                            rarity: previousMagic.rarity || null,
                        },
                        before.selectedRollNumber,
                        `admin_profile_correct_undo:${operation.code}`
                    );
                } else {
                    await releasePlayerCategorySlotsExcept(db, target.playerId, 'magic', null);
                }

                const previousRace = snapshotOption('race', before);
                const previousGrimoire = snapshotOption('grimoire', before);
                if (
                    before.raceLabel
                    && String(before.raceLabel).trim() !== '-'
                    && comparableText(before.raceLabel) !== 'n a'
                    && !previousRace
                ) {
                    throw new AdminPlayerProfileCorrectionError(
                        'previous_race_not_canonical',
                        'Undo bloqueado: a Raça anterior não existe mais no catálogo canônico.',
                        409
                    );
                }
                if (before.grimoireLabel && before.grimoireLabel !== '-' && !previousGrimoire) {
                    throw new AdminPlayerProfileCorrectionError(
                        'previous_grimoire_not_canonical',
                        'Undo bloqueado: o Grimório anterior não existe mais no catálogo canônico.',
                        409
                    );
                }

                await applyCanonicalSlotInTransaction(
                    db,
                    target.playerId,
                    'race',
                    previousRace,
                    before.selectedRollNumber,
                    `admin_profile_correct_undo:${operation.code}`
                );
                await applyCanonicalSlotInTransaction(
                    db,
                    target.playerId,
                    'grimoire',
                    previousGrimoire,
                    before.selectedRollNumber,
                    `admin_profile_correct_undo:${operation.code}`
                );

                await db.run(
                    `UPDATE jogadores
                     SET personagem_nome = ?, magia = ?, magia_key = ?, raca = ?, grimorio = ?, classe = ?
                     WHERE id = ?`,
                    [
                        before.characterName,
                        before.magicLabel,
                        before.magicKey,
                        before.raceLabel,
                        before.grimoireLabel,
                        before.classLabel,
                        target.playerId,
                    ]
                );
            },
        },
    };
}

module.exports = {
    AdminPlayerProfileCorrectionError,
    applyCanonicalSlotInTransaction,
    applyMagicInTransaction,
    createPlayerProfileCorrectionExecutors,
    inferProfileOption,
    normalizeGrimoireInput,
    normalizeMagicInput,
    normalizeProfileCorrectionPayload,
    normalizeRaceInput,
    normalizeSocialClassInput,
    readProfileSnapshot,
    validateFinalProfileState,
};
