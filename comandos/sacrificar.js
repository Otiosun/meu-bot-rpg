const { COMMAND_PREFIX, MAX_PLAYER_ROLLS } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isMagicFlowCriticalStep, renderMagicFlowLockedMessage } = require('../helpers/magicManager');
const { ensurePlayerRecord, getOnboardingState, updateOnboardingStep } = require('../helpers/playerRegistry');
const {
    FINAL_SACRIFICE_ROLL_NUMBER,
    createSacrificeFinalRoll,
    getRareRollImagePath,
    listPlayerRolls,
    renderRollBlock,
} = require('../helpers/rollManager');
const { normalizeText } = require('../helpers/textUtils');
const { tryExecutePreResetSacrifice } = require('../helpers/clover/preResetSacrificeCommand');

function isApproved(player) {
    return ['aprovada', 'confirmada'].includes(String(player?.ficha_status || '').toLowerCase());
}

function renderSacrificeIntro(rollCount) {
    return [
        '.',
        '     --  SACRIFICIO DE ROLLS  --',
        '',
        `*Você pode trocar seus ${MAX_PLAYER_ROLLS} rolls por um único roll final.*`,
        '',
        `↳ Necessário: *${MAX_PLAYER_ROLLS}/${MAX_PLAYER_ROLLS}* rolls.`,
        `↳ Você tem: *${rollCount}/${MAX_PLAYER_ROLLS}*.`,
        '',
        'O roll final vem com chance buffada e mínimo anti-azar.',
        `Depois disso, não dá para voltar aos ${MAX_PLAYER_ROLLS} rolls e nem sortear de novo.`,
        '',
        `Para executar: *${COMMAND_PREFIX}sacrificar confirmar*`,
    ].join('\n');
}

function renderSacrificeUnavailable(reason, rollCount = 0) {
    const reasons = {
        approved: 'Sua ficha já foi aprovada. O sacrifício só vale antes de fechar o cadastro.',
        already_used: 'Você já usou o sacrifício. Esse caminho é definitivo.',
        not_enough_rolls: `Você precisa ter exatamente ${MAX_PLAYER_ROLLS} rolls salvos antes de sacrificar.`,
    };

    return [
        '.',
        '     --  SACRIFICIO INDISPONIVEL  --',
        '',
        reasons[reason] || 'Não dá para sacrificar agora.',
        '',
        `↳ Rolls atuais: *${rollCount}/${MAX_PLAYER_ROLLS}*.`,
        `↳ Use *${COMMAND_PREFIX}rolls* para revisar.`,
    ].join('\n');
}

function renderSacrificeResult(roll) {
    return [
        '.',
        '     --  ROLL FINAL GERADO  --',
        '',
        `*Os ${MAX_PLAYER_ROLLS} rolls foram sacrificados. Esse é o único roll final.*`,
        '',
        renderRollBlock({
            ...roll,
            roll_number: FINAL_SACRIFICE_ROLL_NUMBER,
        }, { isSelected: true }),
        '',
        `↳ Próximo passo: use *${COMMAND_PREFIX}ficha ${FINAL_SACRIFICE_ROLL_NUMBER}*.`,
        `↳ Se quiser conferir de novo, use *${COMMAND_PREFIX}rolls*.`,
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}sacrificar`,
    aliases: [`${COMMAND_PREFIX}sacrificio`, `${COMMAND_PREFIX}sacrificarroll`, `${COMMAND_PREFIX}sacrificar roll`],
    descricao: `Sacrifica os ${MAX_PLAYER_ROLLS} rolls por um unico roll final buffado.`,
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db, body }) => {
        if (await tryExecutePreResetSacrifice({ sock, m, idChat, idJogador, db, body })) return;

        const player = await ensurePlayerRecord(db, idJogador, nomeUsuario);
        const onboarding = await getOnboardingState(db, idJogador);
        const rolls = await listPlayerRolls(db, idJogador);
        const normalizedBody = normalizeText(body);

        if (isMagicFlowCriticalStep(onboarding.current_step)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderMagicFlowLockedMessage(),
            });
            return;
        }

        if (isApproved(player)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderSacrificeUnavailable('approved', rolls.length),
            });
            return;
        }

        if (Number(player.roll_sacrifice_used || 0)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderSacrificeUnavailable('already_used', rolls.length),
            });
            return;
        }

        if (rolls.length !== MAX_PLAYER_ROLLS) {
            await sendReply({
                sock,
                idChat,
                m,
                text: normalizedBody === 'confirmar'
                    ? renderSacrificeUnavailable('not_enough_rolls', rolls.length)
                    : renderSacrificeIntro(rolls.length),
            });
            return;
        }

        if (normalizedBody !== 'confirmar') {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderSacrificeIntro(rolls.length),
            });
            return;
        }

        let result = null;
        await db.exec('BEGIN IMMEDIATE');
        try {
            const latestPlayer = await db.get('SELECT * FROM jogadores WHERE id = ?', [idJogador]);
            const latestRolls = await listPlayerRolls(db, idJogador);

            if (isApproved(latestPlayer)) {
                throw new Error('sacrifice_after_approval');
            }
            if (Number(latestPlayer?.roll_sacrifice_used || 0)) {
                throw new Error('sacrifice_already_used');
            }
            if (latestRolls.length !== MAX_PLAYER_ROLLS) {
                throw new Error('sacrifice_roll_count_changed');
            }

            await db.run('DELETE FROM pending_profile_confirmations WHERE player_id = ?', [idJogador]);
            await db.run('DELETE FROM pending_magic_confirmations WHERE player_id = ?', [idJogador]);
            await db.run(
                `UPDATE slot_reservations
                 SET status = 'released'
                 WHERE player_id = ?
                   AND status IN ('pending', 'confirmed')`,
                [idJogador]
            );
            await db.run('DELETE FROM player_rolls WHERE player_id = ?', [idJogador]);

            result = await createSacrificeFinalRoll(db, idJogador, latestRolls);

            await db.run(
                `UPDATE jogadores
                 SET roll_sacrifice_used = 1,
                     roll_sacrifice_used_at = CURRENT_TIMESTAMP,
                     numero_roll_escolhido = ?,
                     ficha_status = 'incompleta',
                     familia = '-',
                     familia_key = NULL,
                     magia = '-',
                     magia_key = NULL
                 WHERE id = ?`,
                [FINAL_SACRIFICE_ROLL_NUMBER, idJogador]
            );
            await updateOnboardingStep(db, idJogador, 'roll_final_sacrificio', {
                last_message: 'roll_final_sacrificio',
                roll_number: FINAL_SACRIFICE_ROLL_NUMBER,
                sacrificed_rolls: latestRolls.map((roll) => roll.roll_number),
            });

            await db.exec('COMMIT');
        } catch (error) {
            await db.exec('ROLLBACK');
            if (error.message === 'sacrifice_after_approval') {
                await sendReply({ sock, idChat, m, text: renderSacrificeUnavailable('approved', rolls.length) });
                return;
            }
            if (error.message === 'sacrifice_already_used') {
                await sendReply({ sock, idChat, m, text: renderSacrificeUnavailable('already_used', rolls.length) });
                return;
            }
            if (error.message === 'sacrifice_roll_count_changed') {
                await sendReply({ sock, idChat, m, text: renderSacrificeUnavailable('not_enough_rolls', rolls.length) });
                return;
            }
            throw error;
        }

        await sendReply({
            sock,
            idChat,
            m,
            imagePath: result?.roll ? getRareRollImagePath(result.roll) : null,
            text: renderSacrificeResult(result.roll),
        });
    },
};
