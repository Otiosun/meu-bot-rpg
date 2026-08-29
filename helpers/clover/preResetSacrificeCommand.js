'use strict';

const crypto = require('crypto');
const { COMMAND_PREFIX, MAX_PLAYER_ROLLS } = require('../../config/bot');
const { sendReply } = require('../chatReply');
const { normalizeText } = require('../textUtils');
const { getRareRollImagePath, renderRollBlock } = require('../rollManager');
const { applyFutureCharacterMutation, getFutureCharacter } = require('./preResetCharacterService');
const {
    FINAL_FUTURE_SACRIFICE_ROLL_NUMBER,
    createAndStoreFutureSacrificeRoll,
    hasFinalFutureRoll,
    listFutureRolls,
    normalFutureRolls,
} = require('./preResetFutureRollService');
const { getAssignedPreResetState, isPreResetBuildState } = require('./preResetRosterStateService');
const { isPreResetTransitionEnabled } = require('./preResetTransitionService');

function opKey(playerId, messageId, revision) {
    const digest = crypto.createHash('sha256')
        .update(`${playerId}|${messageId || 'no-message'}|${revision}|sacrifice-final`)
        .digest('hex')
        .slice(0, 40);
    return `prereset:sacrifice-draft:${digest}`;
}

function renderIntro(count) {
    return [
        '.',
        '     --  SACRIFICIO DE ROLLS  --',
        '',
        `*Você pode trocar seus ${MAX_PLAYER_ROLLS} rolls por um único roll final #${FINAL_FUTURE_SACRIFICE_ROLL_NUMBER}.*`,
        '',
        `↳ Necessário: *${MAX_PLAYER_ROLLS}/${MAX_PLAYER_ROLLS}* rolls.`,
        `↳ Você tem: *${count}/${MAX_PLAYER_ROLLS}*.`,
        '',
        'O roll final usa pool buffado e piso anti-azar real.',
        `Depois disso, os ${MAX_PLAYER_ROLLS} rolls desaparecem e o #${FINAL_FUTURE_SACRIFICE_ROLL_NUMBER} vira definitivo.`,
        '',
        `Para executar: *${COMMAND_PREFIX}sacrificar confirmar*`,
    ].join('\n');
}

function renderUnavailable(reason, count) {
    const reasons = {
        already_used:`Você já usou o sacrifício. Seu roll final é o #${FINAL_FUTURE_SACRIFICE_ROLL_NUMBER}.`,
        not_enough_rolls:`Você precisa completar os ${MAX_PLAYER_ROLLS} rolls antes de sacrificar.`,
        locked:'Sua Ficha Nova já foi enviada/revisada. Não vou reescrever um personagem futuro fechado.',
    };
    return [
        '.',
        '     --  SACRIFICIO INDISPONIVEL  --',
        '',
        reasons[reason] || 'Não dá para sacrificar agora.',
        '',
        `↳ Rolls normais atuais: *${count}/${MAX_PLAYER_ROLLS}*.`,
        `↳ Use *${COMMAND_PREFIX}rolls* para revisar.`,
    ].join('\n');
}

function renderResult(roll, draftUpdated) {
    return [
        '.',
        '     --  ROLL FINAL GERADO  --',
        '',
        `*Os ${MAX_PLAYER_ROLLS} rolls foram sacrificados. Este é o roll final #${FINAL_FUTURE_SACRIFICE_ROLL_NUMBER}.*`,
        '',
        renderRollBlock(roll, { isSelected:true }),
        '',
        draftUpdated
            ? '↳ Se você já tinha rascunho, ele agora aponta para o roll final e a magia anterior foi limpa para evitar incompatibilidade.'
            : `↳ Use *${COMMAND_PREFIX}ficha ${FINAL_FUTURE_SACRIFICE_ROLL_NUMBER}* quando quiser fechar a ficha.`,
        `↳ Você não pode usar *${COMMAND_PREFIX}sortear* novamente depois do sacrifício.`,
    ].join('\n');
}

async function tryExecutePreResetSacrifice({ sock, m, idChat, idJogador, db, body }) {
    if (!isPreResetTransitionEnabled(process.env)) return false;

    const state = await getAssignedPreResetState(db, idJogador);
    if (!isPreResetBuildState(state)) {
        await sendReply({
            sock, idChat, m,
            text:state?.kind === 'keep'
                ? 'Seu personagem está em MANTER; o sacrifício da Ficha Nova não se aplica.'
                : 'O sacrifício da nova criação ainda não está liberado.',
        });
        return true;
    }

    const rows = await listFutureRolls(db, idJogador);
    const count = normalFutureRolls(rows).length;

    if (hasFinalFutureRoll(rows)) {
        await sendReply({ sock, idChat, m, text:renderUnavailable('already_used', count) });
        return true;
    }

    const normalizedBody = normalizeText(body);
    if (normalizedBody !== 'confirmar') {
        await sendReply({ sock, idChat, m, text:renderIntro(count) });
        return true;
    }

    if (count !== MAX_PLAYER_ROLLS) {
        await sendReply({ sock, idChat, m, text:renderUnavailable('not_enough_rolls', count) });
        return true;
    }

    const character = await getFutureCharacter(db, idJogador);
    if (character && character.status !== 'draft') {
        await sendReply({ sock, idChat, m, text:renderUnavailable('locked', count) });
        return true;
    }

    const result = await createAndStoreFutureSacrificeRoll(db, idJogador);
    if (!result.ok) {
        await sendReply({
            sock, idChat, m,
            text:renderUnavailable(
                result.reason === 'already_used' ? 'already_used' : 'not_enough_rolls',
                Number(result.count || count)
            ),
        });
        return true;
    }

    let draftUpdated = false;
    if (character) {
        try {
            const updated = await applyFutureCharacterMutation(db, idJogador, idJogador, {
                operationType:'update',
                expectedRevision:character.revision,
                operationKey:opKey(idJogador, m?.key?.id, character.revision),
                draft:{
                    ...character.draft,
                    rollNumber:FINAL_FUTURE_SACRIFICE_ROLL_NUMBER,
                    magicKey:null,
                },
            });
            draftUpdated = Boolean(updated?.ok);
        } catch (error) {
            console.warn('[prereset-sacrifice] Roll final salvo, mas nao consegui reposicionar o draft:', error?.message || error);
        }
    }

    await sendReply({
        sock,
        idChat,
        m,
        imagePath:getRareRollImagePath(result.roll),
        text:renderResult(result.roll, draftUpdated),
    });
    return true;
}

module.exports = {
    renderIntro,
    renderResult,
    tryExecutePreResetSacrifice,
};