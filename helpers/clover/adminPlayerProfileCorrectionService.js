'use strict';

const { normalizeText } = require('../textUtils');
const {
    getAllMagics,
    getMagicAvailability,
    getMagicSlotKey,
} = require('../magicManager');
const {
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
    const magic = rawMagic === null || rawMagic === undefined || String(rawMagic).trim() === ''
        ? null
        : normalizeMagicInput(rawMagic);

    if (!characterName && !rawMagic) {
        throw new AdminPlayerProfileCorrectionError(
            'empty_profile_correction',
            'Informe ao menos nome do personagem ou Magia para corrigir.',
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

    return {
        ...(characterName ? { characterName } : {}),
        ...(magic ? {
            magic: {
                key: magic.key || getMagicSlotKey(magic.label),
                label: magic.label || magic.name,
                rarity: magic.rarity || null,
            },
        } : {}),
    };
}

async function readProfileSnapshot(db, playerId) {
    const row = await db.get(
        `SELECT id, personagem_nome, magia, magia_key, numero_roll_escolhido, ficha_status
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
    return {
        playerId: String(row.id),
        characterName: row.personagem_nome || '-',
        magicLabel: row.magia || null,
        magicKey: row.magia_key || null,
        selectedRollNumber: row.numero_roll_escolhido ?? null,
        profileStatus: row.ficha_status || null,
    };
}

function sameSnapshot(left, right) {
    return String(left?.characterName || '-') === String(right?.characterName || '-')
        && String(left?.magicLabel || '') === String(right?.magicLabel || '')
        && String(left?.magicKey || '') === String(right?.magicKey || '');
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

function createPlayerProfileCorrectionExecutors() {
    return {
        'player.profile.correct': {
            async preview({ db, action, target }) {
                const before = await readProfileSnapshot(db, target.playerId);
                const correction = normalizeProfileCorrectionPayload(action.payload || {});
                const after = {
                    ...before,
                    ...(correction.characterName ? { characterName: correction.characterName } : {}),
                    ...(correction.magic ? {
                        magicLabel: correction.magic.label,
                        magicKey: correction.magic.key,
                    } : {}),
                };

                if (correction.magic && correction.magic.key !== before.magicKey) {
                    await assertMagicAvailable(db, target.playerId, correction.magic);
                }

                return {
                    summary: `${target.characterName || target.playerId}: corrigir dados-base do personagem`,
                    before,
                    after,
                    metadata: {
                        fields: [
                            ...(correction.characterName ? ['characterName'] : []),
                            ...(correction.magic ? ['magic'] : []),
                        ],
                        magic: correction.magic || null,
                    },
                };
            },

            async apply({ db, operation, action, target, before, after }) {
                await assertSnapshot(db, target.playerId, before, 'profile_changed_after_preview');
                const correction = normalizeProfileCorrectionPayload(action.payload || {});

                if (correction.magic && correction.magic.key !== before.magicKey) {
                    await applyMagicInTransaction(
                        db,
                        target.playerId,
                        correction.magic,
                        before.selectedRollNumber,
                        `admin_profile_correct:${operation.code}`
                    );
                }

                await db.run(
                    `UPDATE jogadores
                     SET personagem_nome = ?, magia = ?, magia_key = ?
                     WHERE id = ?`,
                    [
                        after.characterName,
                        after.magicLabel,
                        after.magicKey,
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

                await db.run(
                    `UPDATE jogadores
                     SET personagem_nome = ?, magia = ?, magia_key = ?
                     WHERE id = ?`,
                    [
                        before.characterName,
                        before.magicLabel,
                        before.magicKey,
                        target.playerId,
                    ]
                );
            },
        },
    };
}

module.exports = {
    AdminPlayerProfileCorrectionError,
    applyMagicInTransaction,
    createPlayerProfileCorrectionExecutors,
    normalizeMagicInput,
    normalizeProfileCorrectionPayload,
    readProfileSnapshot,
};
