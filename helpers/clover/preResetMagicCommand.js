'use strict';

const crypto = require('crypto');
const { COMMAND_PREFIX } = require('../../config/bot');
const { sendReply } = require('../chatReply');
const {
    findMagicOptions,
    getAllMagics,
    getAvailableMagicsForRoll,
    getMagicSlotKey,
    getRarityMeta,
    renderMagicAmbiguousMessage,
} = require('../magicManager');
const { applyFutureCharacterMutation, getFutureCharacter } = require('./preResetCharacterService');
const {
    FINAL_FUTURE_SACRIFICE_ROLL_NUMBER,
    listFutureRolls,
    normalFutureRolls,
} = require('./preResetFutureRollService');
const { getFutureSlotAvailability } = require('./preResetFutureSlotService');
const { getAssignedPreResetState, isPreResetBuildState } = require('./preResetRosterStateService');
const { isPreResetTransitionEnabled } = require('./preResetTransitionService');

const RARITIES = ['Comum', 'Incomum', 'Rara', 'Epica', 'Lendaria', 'Mitica'];

function opKey(playerId, messageId, revision, magicKey, rollNumber) {
    const digest = crypto.createHash('sha256')
        .update(`${playerId}|${messageId || 'no-message'}|${revision}|${magicKey || 'none'}|${rollNumber || 0}`)
        .digest('hex')
        .slice(0, 40);
    return `prereset:magic:${digest}`;
}

function getMagicLabelByKey(key) {
    return getAllMagics().find((magic) => magic.key === String(key || '').trim())?.label || null;
}

function usableRolls(rows) {
    const final = (rows || []).find((row) =>
        Number(row.roll_number) === FINAL_FUTURE_SACRIFICE_ROLL_NUMBER
    );
    return final ? [final] : normalFutureRolls(rows);
}

function compatibleRollsForMagic(rolls, magic) {
    const key = String(magic?.key || '').trim();
    return (rolls || []).filter((roll) =>
        getAvailableMagicsForRoll(roll).some((option) => option.key === key)
    );
}

function parseChoiceInput(input, rolls) {
    const raw = String(input || '').trim();
    if (!raw) return { magicInput:'', explicitRollNumber:null };

    const match = raw.match(/^(.*?)\s+#?(\d+)$/);
    if (match) {
        const number = Number(match[2]);
        const magicInput = match[1].trim();
        const rollExists = (rolls || []).some((roll) => Number(roll.roll_number) === number);
        const magicExists = findMagicOptions(getAllMagics(), magicInput).length > 0;
        if (rollExists && magicExists) {
            return { magicInput, explicitRollNumber:number };
        }
    }

    return { magicInput:raw, explicitRollNumber:null };
}

async function getContext(db, playerId) {
    const state = await getAssignedPreResetState(db, playerId);
    if (!isPreResetBuildState(state)) return { ok:false, state, reason:'not_build' };

    const allRolls = await listFutureRolls(db, playerId);
    const rolls = usableRolls(allRolls);
    if (!rolls.length) return { ok:false, state, reason:'no_rolls' };

    const character = await getFutureCharacter(db, playerId);
    return { ok:true, state, rolls, character };
}

function contextError(context) {
    if (context.reason === 'no_rolls') return `Use *${COMMAND_PREFIX}sortear* primeiro.`;
    return context.state?.kind === 'keep'
        ? 'Seu personagem está em MANTER; a escolha de magia da Ficha Nova não se aplica.'
        : 'A escolha de magia da nova fase ainda não está liberada para este cadastro.';
}

function bestRollMeta(rolls) {
    const best = [...(rolls || [])].sort((a, b) =>
        getRarityMeta(b.magic_rarity).level - getRarityMeta(a.magic_rarity).level
    )[0];
    return best ? getRarityMeta(best.magic_rarity) : getRarityMeta('Comum');
}

async function buildMagicAvailabilityMap(db) {
    const limited = getAllMagics().filter((magic) => Number(magic.capacity || 0) > 0);
    const entries = await Promise.all(limited.map(async (magic) => [
        magic.key,
        await getFutureSlotAvailability(db, 'magic', magic.key),
    ]));
    return new Map(entries);
}

function formatAvailability(availability) {
    if (!availability?.limited) return 'livre';
    return `${availability.usedCount}/${availability.capacity}`;
}

function formatAvailabilityDetail(availability) {
    if (!availability?.limited) return 'Livre';
    const plural = availability.remaining === 1 ? 'vaga restante' : 'vagas restantes';
    return `${availability.usedCount}/${availability.capacity} ocupadas · ${availability.remaining} ${plural}`;
}

function renderList(rolls, character = null, availabilityByKey = new Map()) {
    const all = getAllMagics();
    const selectedKey = character?.draft?.magicKey || null;
    const selectedRoll = Number(character?.draft?.rollNumber || 0) || null;
    const capMeta = bestRollMeta(rolls);
    const lines = [
        '.',
        '     ──  𝐌𝐀𝐆𝐈𝐀𝐒 𝐃𝐈𝐒𝐏𝐎𝐍𝐈́𝐕𝐄𝐈𝐒  ──',
        '',
        '*♡  Escolha sua magia com calma.*',
        '',
        `↳ *Rolls atuais:* ${rolls.length}.`,
        `↳ *Maior raridade liberada:* ${capMeta.emoji} *${capMeta.label}*.`,
        '↳ A lista mostra vaga real do PRE_RESET e se a magia cabe em pelo menos um dos seus rolls.',
        `↳ Escolha com *${COMMAND_PREFIX}magia <nome>*. Se mais de um roll servir, eu pergunto qual depois.`,
    ];

    for (const rarity of RARITIES) {
        const options = all.filter((magic) => magic.rarity === rarity);
        if (!options.length) continue;

        const meta = getRarityMeta(rarity);
        lines.push('', '.', `     ──  𝐂𝐋𝐀𝐒𝐒𝐄 ${meta.headerLabel}  ${meta.emoji} ──`, '');

        for (const magic of options) {
            const compatible = compatibleRollsForMagic(rolls, magic);
            const availability = availabilityByKey.get(magic.key) || {
                ok:true,
                limited:false,
                usedCount:0,
                capacity:null,
                remaining:null,
            };
            const slot = formatAvailability(availability);
            const selected = selectedKey === magic.key;
            const selectedHere = selected && (!selectedRoll || compatible.some((roll) =>
                Number(roll.roll_number) === selectedRoll
            ));
            const state = availability.limited && !availability.ok
                ? 'esgotada'
                : compatible.length
                    ? 'disponível'
                    : 'acima dos seus rolls';
            lines.push(
                `﹒ ${magic.label} *(${slot})* · ${state}${selectedHere ? ' · ✓ escolhida' : ''}`
            );
        }
    }

    return lines.join('\n');
}

function renderRollChoice(choice, matches) {
    return [
        '.',
        '     ──  𝐑𝐎𝐋𝐋 𝐃𝐀 𝐌𝐀𝐆𝐈𝐀  ──',
        '',
        `*${choice.label}* cabe em mais de um dos seus rolls:`,
        '',
        ...matches.map((roll) => `• *Roll ${roll.roll_number}* · ${roll.kingdom} · ${getRarityMeta(roll.magic_rarity).emoji} ${getRarityMeta(roll.magic_rarity).label}`),
        '',
        `Escolha com *${COMMAND_PREFIX}magia ${choice.label} <número>*`,
        `Ex.: *${COMMAND_PREFIX}magia ${choice.label} ${matches[0].roll_number}*`,
    ].join('\n');
}

async function saveMagicDraft({ db, playerId, m, character, rollNumber, magicKey }) {
    if (!character) {
        return applyFutureCharacterMutation(db, playerId, playerId, {
            operationType:'create',
            expectedRevision:0,
            operationKey:opKey(playerId, m?.key?.id, 0, magicKey, rollNumber),
            draft:{ rollNumber:Number(rollNumber), magicKey },
        });
    }

    return applyFutureCharacterMutation(db, playerId, playerId, {
        operationType:'update',
        expectedRevision:character.revision,
        operationKey:opKey(playerId, m?.key?.id, character.revision, magicKey, rollNumber),
        draft:{ ...character.draft, rollNumber:Number(rollNumber), magicKey },
    });
}

async function tryExecutePreResetMagic({ sock, m, idChat, idJogador, db, body }) {
    if (!isPreResetTransitionEnabled(process.env)) return false;

    const context = await getContext(db, idJogador);
    if (!context.ok) {
        await sendReply({ sock, idChat, m, text:contextError(context) });
        return true;
    }

    const { rolls, character } = context;
    const input = String(body || '').trim();

    if (!input) {
        const availabilityByKey = await buildMagicAvailabilityMap(db);
        await sendReply({
            sock,
            idChat,
            m,
            text:renderList(rolls, character, availabilityByKey),
        });
        return true;
    }

    if (character && character.status !== 'draft') {
        await sendReply({
            sock, idChat, m,
            text:'Sua Ficha Nova já foi enviada/revisada; a magia futura não pode mais ser alterada pelo jogador.',
        });
        return true;
    }

    const parsed = parseChoiceInput(input, rolls);
    const matches = findMagicOptions(getAllMagics(), parsed.magicInput);

    if (matches.length > 1) {
        await sendReply({ sock, idChat, m, text:renderMagicAmbiguousMessage(parsed.magicInput, matches) });
        return true;
    }

    const choice = matches[0] || null;
    if (!choice) {
        await sendReply({
            sock, idChat, m,
            text:`Não encontrei *${parsed.magicInput || input}*. Use *${COMMAND_PREFIX}magias* para ver a lista completa.`,
        });
        return true;
    }

    const compatible = compatibleRollsForMagic(rolls, choice);
    if (!compatible.length) {
        const magicMeta = getRarityMeta(choice.rarity);
        const capMeta = bestRollMeta(rolls);
        await sendReply({
            sock,
            idChat,
            m,
            text:[
                '.',
                '     ──  MAGIA BLOQUEADA  ──',
                '',
                `*${choice.label}* é ${magicMeta.emoji} ${magicMeta.label}.`,
                `Seus rolls liberam no máximo ${capMeta.emoji} ${capMeta.label}.`,
                '',
                `Use *${COMMAND_PREFIX}magias* para escolher outra.`,
            ].join('\n'),
        });
        return true;
    }

    let chosenRoll = null;

    if (parsed.explicitRollNumber) {
        chosenRoll = compatible.find((roll) =>
            Number(roll.roll_number) === Number(parsed.explicitRollNumber)
        ) || null;
        if (!chosenRoll) {
            await sendReply({ sock, idChat, m, text:renderRollChoice(choice, compatible) });
            return true;
        }
    }

    if (!chosenRoll && character?.draft?.rollNumber) {
        chosenRoll = compatible.find((roll) =>
            Number(roll.roll_number) === Number(character.draft.rollNumber)
        ) || null;
    }

    if (!chosenRoll && compatible.length === 1) chosenRoll = compatible[0];

    if (!chosenRoll) {
        await sendReply({ sock, idChat, m, text:renderRollChoice(choice, compatible) });
        return true;
    }

    const magicKey = choice.key || getMagicSlotKey(choice.label);
    const availability = await getFutureSlotAvailability(db, 'magic', magicKey);
    if (!availability.ok) {
        await sendReply({
            sock,
            idChat,
            m,
            text:[
                '.',
                '     ──  MAGIA INDISPONÍVEL  ──',
                '',
                `*${choice.label}* está esgotada no universo futuro.`,
                `↳ *Vagas:* ${formatAvailabilityDetail(availability)}.`,
                '',
                `Use *${COMMAND_PREFIX}magias* para escolher outra.`,
            ].join('\n'),
        });
        return true;
    }

    if (
        character?.draft?.magicKey === magicKey
        && Number(character?.draft?.rollNumber) === Number(chosenRoll.roll_number)
    ) {
        await sendReply({
            sock,
            idChat,
            m,
            text:[
                `*${choice.label}* já está salva no *Roll ${chosenRoll.roll_number}* do seu personagem futuro.`,
                `↳ *Vagas agora:* ${formatAvailabilityDetail(availability)}.`,
            ].join('\n'),
        });
        return true;
    }

    const result = await saveMagicDraft({
        db,
        playerId:idJogador,
        m,
        character,
        rollNumber:chosenRoll.roll_number,
        magicKey,
    });

    await sendReply({
        sock, idChat, m,
        text:[
            '.',
            '     ──  𝐌𝐀𝐆𝐈𝐀 𝐅𝐔𝐓𝐔𝐑𝐀  ──',
            '',
            `↳ *Magia:* ${choice.label}`,
            `↳ *Classe:* ${getRarityMeta(choice.rarity).emoji} ${getRarityMeta(choice.rarity).label}`,
            `↳ *Roll vinculado:* ${chosenRoll.roll_number} · ${chosenRoll.kingdom}`,
            `↳ *Vagas agora:* ${formatAvailabilityDetail(availability)}.`,
            '',
            result.duplicate ? 'Alteração já registrada; nada foi duplicado.' : 'Escolha salva somente no personagem futuro.',
            'A vaga limitada é conferida novamente quando a Ficha Nova for enviada.',
            `↳ Use *${COMMAND_PREFIX}magias* para rever ou trocar.`,
        ].join('\n'),
    });
    return true;
}

async function tryCancelPreResetMagic({ sock, m, idChat, idJogador, db }) {
    if (!isPreResetTransitionEnabled(process.env)) return false;

    const state = await getAssignedPreResetState(db, idJogador);
    if (!isPreResetBuildState(state)) {
        await sendReply({ sock, idChat, m, text:contextError({ state, reason:'not_build' }) });
        return true;
    }

    const character = await getFutureCharacter(db, idJogador);
    if (!character?.draft?.magicKey) {
        await sendReply({ sock, idChat, m, text:`Nenhuma magia futura está salva. Use *${COMMAND_PREFIX}magias* para escolher.` });
        return true;
    }
    if (character.status !== 'draft') {
        await sendReply({ sock, idChat, m, text:'Sua Ficha Nova já foi enviada/revisada; a magia futura não pode mais ser removida pelo jogador.' });
        return true;
    }

    const label = getMagicLabelByKey(character.draft.magicKey) || character.draft.magicKey;
    await applyFutureCharacterMutation(db, idJogador, idJogador, {
        operationType:'update',
        expectedRevision:character.revision,
        operationKey:opKey(
            idJogador,
            m?.key?.id,
            character.revision,
            null,
            character.draft?.rollNumber
        ),
        draft:{ ...character.draft, magicKey:null },
    });

    await sendReply({
        sock, idChat, m,
        text:`*${label}* foi removida somente do personagem futuro. Use *${COMMAND_PREFIX}magias* para escolher outra.`,
    });
    return true;
}

module.exports = {
    bestRollMeta,
    buildMagicAvailabilityMap,
    compatibleRollsForMagic,
    formatAvailability,
    formatAvailabilityDetail,
    getMagicLabelByKey,
    parseChoiceInput,
    renderList,
    tryCancelPreResetMagic,
    tryExecutePreResetMagic,
    usableRolls,
};
