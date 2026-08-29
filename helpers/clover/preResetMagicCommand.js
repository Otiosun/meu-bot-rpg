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

function rollSummary(roll) {
    const meta = getRarityMeta(roll.magic_rarity);
    return `#${roll.roll_number} ${meta.emoji} ${meta.label}`;
}

function renderList(rolls, character = null) {
    const all = getAllMagics();
    const selectedKey = character?.draft?.magicKey || null;
    const selectedRoll = Number(character?.draft?.rollNumber || 0) || null;
    const lines = [
        '*♧┃PRE_RESET · MAGIAS*',
        '',
        `*Seus rolls:* ${rolls.map(rollSummary).join(' · ')}`,
        `↳ Escolha direto com *${COMMAND_PREFIX}magia <nome>*.`,
        '↳ Você NÃO precisa abrir a ficha nem escolher roll antes.',
        '↳ Se a magia couber em vários rolls, eu peço o número só nessa hora.',
    ];

    for (const rarity of RARITIES) {
        const options = all.filter((magic) => magic.rarity === rarity);
        const visible = options
            .map((magic) => ({ magic, matches:compatibleRollsForMagic(rolls, magic) }))
            .filter((entry) => entry.matches.length);
        if (!visible.length) continue;

        const meta = getRarityMeta(rarity);
        lines.push('', `── ${meta.headerLabel} ${meta.emoji} ──`);
        for (const { magic, matches } of visible) {
            const numbers = matches.map((roll) => `#${roll.roll_number}`).join('/');
            const selected = selectedKey === magic.key && matches.some((roll) =>
                Number(roll.roll_number) === selectedRoll
            );
            lines.push(`﹒ ${magic.label} · ${numbers}${selected ? ' · ✓ escolhida' : ''}`);
        }
    }

    return lines.join('\n');
}

function renderRollChoice(choice, matches) {
    return [
        `*${choice.label}* cabe em mais de um dos seus rolls:`,
        '',
        ...matches.map((roll) => `• *#${roll.roll_number}* · ${roll.kingdom} · ${roll.magic_rarity}`),
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
        await sendReply({ sock, idChat, m, text:renderList(rolls, character) });
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
            text:`Não encontrei *${parsed.magicInput || input}*. Use *${COMMAND_PREFIX}magias* para ver as opções que cabem nos seus rolls.`,
        });
        return true;
    }

    const compatible = compatibleRollsForMagic(rolls, choice);
    if (!compatible.length) {
        await sendReply({
            sock, idChat, m,
            text:`*${choice.label}* não cabe em nenhum dos seus rolls atuais. Use *${COMMAND_PREFIX}magias* para ver as opções disponíveis.`,
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
            sock, idChat, m,
            text:`*${choice.label}* está sem vaga no universo futuro. Use *${COMMAND_PREFIX}magias* para escolher outra.`,
        });
        return true;
    }

    if (
        character?.draft?.magicKey === magicKey
        && Number(character?.draft?.rollNumber) === Number(chosenRoll.roll_number)
    ) {
        await sendReply({
            sock, idChat, m,
            text:`*${choice.label}* já está salva no roll *#${chosenRoll.roll_number}* do seu rascunho futuro.`,
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
            '*♧┃PRE_RESET · MAGIA FUTURA SALVA*',
            '',
            `*Magia:* ${choice.label}`,
            `*Roll:* #${chosenRoll.roll_number}`,
            result.duplicate ? 'Alteração já registrada; nada foi duplicado.' : 'Salva somente no personagem futuro.',
            'Você ainda pode continuar sorteando e mudar isso antes de enviar a Ficha Nova.',
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
    compatibleRollsForMagic,
    getMagicLabelByKey,
    parseChoiceInput,
    renderList,
    tryCancelPreResetMagic,
    tryExecutePreResetMagic,
    usableRolls,
};