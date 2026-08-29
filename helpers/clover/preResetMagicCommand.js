'use strict';

const crypto = require('crypto');
const { COMMAND_PREFIX } = require('../../config/bot');
const { sendReply } = require('../chatReply');
const {
    findMagicOption,
    findMagicOptions,
    getAllMagics,
    getAvailableMagicsForRoll,
    getMagicSlotKey,
    getRarityMeta,
    renderMagicAmbiguousMessage,
    renderMagicNotFoundMessage,
    renderMagicRarityBlockedMessage,
} = require('../magicManager');
const { applyFutureCharacterMutation, getFutureCharacter } = require('./preResetCharacterService');
const { getFutureRollByNumber, listFutureRolls } = require('./preResetFutureRollService');
const { getFutureSlotAvailability } = require('./preResetFutureSlotService');
const { getAssignedPreResetState, isPreResetBuildState } = require('./preResetRosterStateService');
const { isPreResetTransitionEnabled } = require('./preResetTransitionService');

const RARITIES = ['Comum', 'Incomum', 'Rara', 'Epica', 'Lendaria', 'Mitica'];

function opKey(playerId, messageId, revision, magicKey) {
    const digest = crypto.createHash('sha256')
        .update(`${playerId}|${messageId || 'no-message'}|${revision}|${magicKey || 'none'}`)
        .digest('hex')
        .slice(0, 40);
    return `prereset:magic:${digest}`;
}

function getMagicLabelByKey(key) {
    return getAllMagics().find((magic) => magic.key === String(key || '').trim())?.label || null;
}

async function getContext(db, playerId) {
    const state = await getAssignedPreResetState(db, playerId);
    if (!isPreResetBuildState(state)) return { ok:false, state, reason:'not_build' };
    const rolls = await listFutureRolls(db, playerId);
    if (!rolls.length) return { ok:false, state, reason:'no_rolls' };
    const character = await getFutureCharacter(db, playerId);
    const rollNumber = Number(character?.draft?.rollNumber || 0) || null;
    if (!character || !rollNumber) return { ok:false, state, reason:'no_selected_roll' };
    const roll = await getFutureRollByNumber(db, playerId, rollNumber);
    return roll ? { ok:true, state, character, roll } : { ok:false, state, reason:'missing_roll' };
}

function contextError(context) {
    if (context.reason === 'no_rolls') return `Use *${COMMAND_PREFIX}sortear* primeiro.`;
    if (context.reason === 'no_selected_roll') return `Escolha primeiro seu roll futuro com *${COMMAND_PREFIX}ficha <número>.*`;
    if (context.reason === 'missing_roll') return `Seu roll futuro selecionado sumiu. Use *${COMMAND_PREFIX}rolls* e depois *${COMMAND_PREFIX}ficha <número>.*`;
    return context.state?.kind === 'keep'
        ? 'Seu personagem está em MANTER; a escolha de magia da Ficha Nova não se aplica.'
        : 'A escolha de magia da nova fase ainda não está liberada para este cadastro.';
}

function renderList(roll, selectedKey) {
    const allowed = new Set(getAvailableMagicsForRoll(roll).map((magic) => magic.key));
    const all = getAllMagics();
    const rollMeta = getRarityMeta(roll.magic_rarity);
    const lines = [
        '*♧┃PRE_RESET · MAGIAS*',
        '',
        `*Roll futuro:* #${roll.roll_number} · ${roll.kingdom || '-'} · ${rollMeta.emoji} ${rollMeta.label}`,
        `↳ Escolha com *${COMMAND_PREFIX}magia <nome>* ou *${COMMAND_PREFIX}magias <nome>*.`,
        '↳ Esta tela e a escolha abaixo mexem somente no personagem futuro.',
    ];
    for (const rarity of RARITIES) {
        const options = all.filter((magic) => magic.rarity === rarity);
        if (!options.length) continue;
        const meta = getRarityMeta(rarity);
        lines.push('', `── ${meta.headerLabel} ${meta.emoji} ──`);
        for (const option of options) {
            const suffix = selectedKey === option.key
                ? ' · ✓ escolhida'
                : allowed.has(option.key) ? ' · disponível' : ' · acima do roll';
            lines.push(`﹒ ${option.label}${suffix}`);
        }
    }
    return lines.join('\n');
}

async function tryExecutePreResetMagic({ sock, m, idChat, idJogador, db, body }) {
    if (!isPreResetTransitionEnabled(process.env)) return false;
    const context = await getContext(db, idJogador);
    if (!context.ok) {
        await sendReply({ sock, idChat, m, text:contextError(context) });
        return true;
    }

    const { character, roll } = context;
    const input = String(body || '').trim();
    if (!input) {
        await sendReply({ sock, idChat, m, text:renderList(roll, character.draft?.magicKey) });
        return true;
    }
    if (character.status !== 'draft') {
        await sendReply({ sock, idChat, m, text:'Sua Ficha Nova já foi enviada/revisada; a magia futura não pode mais ser alterada pelo jogador.' });
        return true;
    }

    const matches = findMagicOptions(getAllMagics(), input);
    if (matches.length > 1) {
        await sendReply({ sock, idChat, m, text:renderMagicAmbiguousMessage(input, matches) });
        return true;
    }
    const globalChoice = matches[0] || null;
    const choice = globalChoice ? findMagicOption(getAvailableMagicsForRoll(roll), input) : null;
    if (globalChoice && !choice) {
        await sendReply({ sock, idChat, m, text:renderMagicRarityBlockedMessage(globalChoice, roll) });
        return true;
    }
    if (!choice) {
        await sendReply({ sock, idChat, m, text:renderMagicNotFoundMessage(input, roll) });
        return true;
    }

    const magicKey = choice.key || getMagicSlotKey(choice.label);
    const availability = await getFutureSlotAvailability(db, 'magic', magicKey);
    if (!availability.ok) {
        await sendReply({ sock, idChat, m, text:`*${choice.label}* está sem vaga no universo futuro. Use *${COMMAND_PREFIX}magias* para escolher outra.` });
        return true;
    }
    if (character.draft?.magicKey === magicKey) {
        await sendReply({ sock, idChat, m, text:`*${choice.label}* já está salva no seu rascunho futuro.` });
        return true;
    }

    const result = await applyFutureCharacterMutation(db, idJogador, idJogador, {
        operationType:'update',
        expectedRevision:character.revision,
        operationKey:opKey(idJogador, m?.key?.id, character.revision, magicKey),
        draft:{ ...character.draft, magicKey },
    });
    await sendReply({
        sock, idChat, m,
        text:[
            '*♧┃PRE_RESET · MAGIA FUTURA SALVA*',
            '',
            `*Magia:* ${choice.label}`,
            `*Roll:* #${roll.roll_number}`,
            result.duplicate ? 'Alteração já registrada; nada foi duplicado.' : 'Salva somente no rascunho futuro.',
            'A vaga limitada é confirmada novamente no envio válido da Ficha Nova.',
            `↳ Na *Ficha Nova*, mantenha o campo Magia como *${choice.label}*.`,
        ].join('\n'),
    });
    return true;
}

async function tryCancelPreResetMagic({ sock, m, idChat, idJogador, db }) {
    if (!isPreResetTransitionEnabled(process.env)) return false;
    const context = await getContext(db, idJogador);
    if (!context.ok) {
        await sendReply({ sock, idChat, m, text:contextError(context) });
        return true;
    }
    const { character } = context;
    if (character.status !== 'draft') {
        await sendReply({ sock, idChat, m, text:'Sua Ficha Nova já foi enviada/revisada; a magia futura não pode mais ser removida pelo jogador.' });
        return true;
    }
    if (!character.draft?.magicKey) {
        await sendReply({ sock, idChat, m, text:`Nenhuma magia futura está salva. Use *${COMMAND_PREFIX}magias* para escolher.` });
        return true;
    }
    const label = getMagicLabelByKey(character.draft.magicKey) || character.draft.magicKey;
    await applyFutureCharacterMutation(db, idJogador, idJogador, {
        operationType:'update',
        expectedRevision:character.revision,
        operationKey:opKey(idJogador, m?.key?.id, character.revision, null),
        draft:{ ...character.draft, magicKey:null },
    });
    await sendReply({ sock, idChat, m, text:`*${label}* foi removida somente do seu rascunho futuro. Use *${COMMAND_PREFIX}magias* para escolher outra.` });
    return true;
}

module.exports = { getMagicLabelByKey, renderList, tryCancelPreResetMagic, tryExecutePreResetMagic };
