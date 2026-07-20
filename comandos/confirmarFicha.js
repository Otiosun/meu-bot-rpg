const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    getCloverRegistrationGroup,
    maybeSendPostFichaPrivateInstructions,
    renderRegistrationGroupMissingNotice,
    sendCloverRegistrationSummary,
} = require('../helpers/clover/registrationManager');
const { syncArchiveCardForPlayer } = require('../helpers/clover/archiveManager');
const { sendAppearancePendingNotice } = require('../helpers/clover/appearanceManager');
const {
    readProfileAccessSnapshot,
    restoreReleasedAccessAfterProfileConfirmation,
} = require('../helpers/clover/profileAccessPreservationService');
const { confirmPendingProfile, renderValidationErrors } = require('../helpers/profileForms');
const { renderMagicChoicePrompt } = require('../helpers/magicManager');
const { updateOnboardingStep } = require('../helpers/playerRegistry');

function isAppearanceApproved(player) {
    return ['approved', 'aprovada'].includes(String(player?.personagem_aparencia_status || '').toLowerCase());
}

async function hasRegistrationAppearanceReview(db, playerId) {
    const row = await db.get(
        `SELECT 1 AS found
         FROM clover_appearance_reviews
         WHERE player_id = ?
           AND scope = 'registration'
         LIMIT 1`,
        [playerId]
    );
    return Boolean(row?.found);
}

async function sendRegistrationAppearanceNoticeSafely({ sock, db, playerId, groupId }) {
    if (!groupId) {
        return {
            ok: false,
            skipped: true,
            line: renderRegistrationGroupMissingNotice(),
        };
    }

    try {
        const result = await sendAppearancePendingNotice({
            sock,
            db,
            playerId,
            groupId,
            scope: 'registration',
        });
        if (result?.skipped) {
            return {
                ok: false,
                skipped: true,
                reason: result.reason,
                line: result.reason === 'missing_appearance'
                    ? 'Nao encontrei uma aparencia salva para enviar ao grupo de registro.'
                    : 'Nao consegui preparar o envio de aparencia ao grupo de registro.',
            };
        }
        return {
            ok: true,
            skipped: false,
            line: 'A aparencia foi enviada para avaliacao da administracao.',
        };
    } catch (error) {
        console.log(`[confirmarFicha] Nao consegui enviar aparencia para avaliacao de ${playerId}:`, error?.message || error);
        return {
            ok: false,
            skipped: false,
            error,
            line: `Nao consegui enviar a aparencia ao grupo de registro. Tente *${COMMAND_PREFIX}confirmarFicha* de novo quando o bot estiver online.`,
        };
    }
}

async function retryConfirmedProfileDelivery({ sock, db, playerId }) {
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    const groupId = await getCloverRegistrationGroup(db);
    const lines = [
        'Sua ficha ja estava confirmada.',
        '',
    ];

    if (!await hasRegistrationAppearanceReview(db, playerId)) {
        const appearanceNotice = await sendRegistrationAppearanceNoticeSafely({
            sock,
            db,
            playerId,
            groupId,
        });
        lines.push(appearanceNotice.ok
            ? 'Reenviei a aparencia para avaliacao no grupo de registro.'
            : appearanceNotice.line);
    } else {
        lines.push('A avaliacao de aparencia ja tem mensagem registrada no grupo de registro.');
    }

    if (isAppearanceApproved(player)) {
        const pv = await maybeSendPostFichaPrivateInstructions(sock, db, playerId);
        if (pv.ok && !pv.skipped) {
            lines.push('Reenviei o PV de historia/persona.');
        } else if (pv.skipped && pv.reason === 'already_sent') {
            lines.push('O PV de historia/persona ja estava marcado como enviado.');
        } else if (!pv.ok) {
            console.log(`[confirmarFicha] Nao consegui reenviar PV de historia para ${playerId}:`, pv.error?.message || pv.error);
            lines.push('Nao consegui reenviar o PV de historia/persona agora.');
        }
    } else {
        lines.push('O PV de historia/persona so sai depois que a aparencia for aprovada.');
    }

    return lines.join('\n');
}

async function syncArchiveSafely(sock, db, playerId) {
    try {
        await syncArchiveCardForPlayer({ sock, db, playerId });
    } catch (error) {
        console.log(`[arquivo] Nao consegui sincronizar ficha de ${playerId}:`, error?.message || error);
    }
}

module.exports = {
    nome: `${COMMAND_PREFIX}confirmar`,
    aliases: [
        `${COMMAND_PREFIX}confirmar ficha`,
        `${COMMAND_PREFIX}confirmarficha`,
    ],
    descricao: 'Confirma a ficha validada e avanca para a escolha de magia.',
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        const accessBeforeConfirmation = await readProfileAccessSnapshot(db, idJogador);
        const result = await confirmPendingProfile(db, idJogador);
        if (!result.ok) {
            if (result.errors?.length) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: renderValidationErrors(result.errors),
                });
                return;
            }

            const player = await db.get('SELECT ficha_status FROM jogadores WHERE id = ?', [idJogador]);
            if (player && ['confirmada', 'aprovada'].includes(player.ficha_status)) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: await retryConfirmedProfileDelivery({ sock, db, playerId: idJogador }),
                });
                return;
            }

            await sendReply({
                sock,
                idChat,
                m,
                text: `⚠️ Você não tem nenhuma ficha pendente para confirmar. Use *${COMMAND_PREFIX}Ficha* primeiro.`,
            });
            return;
        }

        const accessPreservation = await restoreReleasedAccessAfterProfileConfirmation(
            db,
            idJogador,
            accessBeforeConfirmation
        );
        if (accessPreservation.player) {
            result.player = {
                ...result.player,
                ...accessPreservation.player,
            };
        }
        if (accessPreservation.restored) {
            console.log(`[confirmarFicha] Acesso liberado preservado para ${idJogador}.`);
        }

        const magicAlreadyChosen = result.player?.magia && result.player.magia !== '-';
        await syncArchiveSafely(sock, db, idJogador);

        if (magicAlreadyChosen) {
            await updateOnboardingStep(db, idJogador, 'cadastro_aprovado', {
                last_message: 'ficha_confirmada_magia_ja_escolhida',
                roll_number: result.payload.numeroRoll,
                magia: result.player.magia,
            });

            const registration = await sendCloverRegistrationSummary(sock, db, idJogador, result);
            const registrationGroupId = await getCloverRegistrationGroup(db);
            const appearanceNotice = await sendRegistrationAppearanceNoticeSafely({
                sock,
                db,
                playerId: idJogador,
                groupId: registrationGroupId,
            });
            const registrationLine = registration.skipped
                ? renderRegistrationGroupMissingNotice()
                : registration.ok
                ? 'Resumo enviado ao grupo de registro Clover.'
                : 'Nao consegui enviar o resumo ao grupo de registro Clover; a ficha foi confirmada mesmo assim.';

            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*Recepcao base concluida com sucesso.*',
                    '',
                    `Sua magia ja estava escolhida: *${result.player.magia}*.`,
                    `Roll vinculado: *#${String(result.payload.numeroRoll).padStart(2, '0')}*.`,
                    '',
                    appearanceNotice.line,
                    'O PV de historia/persona sera enviado depois que a aparencia for aprovada.',
                    registrationLine,
                ].join('\n'),
            });
            return;
        }

        await updateOnboardingStep(db, idJogador, 'escolha_magia', {
            last_message: 'pedir_magia',
            roll_number: result.payload.numeroRoll,
        });

        await sendReply({
            sock,
            idChat,
            m,
            text: await renderMagicChoicePrompt(db, result.payload.roll),
        });
    },
};
