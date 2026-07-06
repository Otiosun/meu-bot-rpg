const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner } = require('../helpers/groupAccess');
const { getPendingMagicConfirmation } = require('../helpers/magicManager');
const { getPendingConfirmation } = require('../helpers/profileForms');
const { getOnboardingState, getPlayerRecord } = require('../helpers/playerRegistry');
const { getPlayerRollByNumber, getPlayerRollCount } = require('../helpers/rollManager');

function getContextInfo(messageNode) {
    return messageNode?.extendedTextMessage?.contextInfo
        || messageNode?.imageMessage?.contextInfo
        || messageNode?.videoMessage?.contextInfo
        || null;
}

function resolveTargetPlayerId(m, fallbackPlayerId) {
    const contextInfo = getContextInfo(m.message);
    const mentioned = contextInfo?.mentionedJid?.find(Boolean);
    if (mentioned) return mentioned;

    const quotedParticipant = contextInfo?.participant;
    if (quotedParticipant) return quotedParticipant;

    return fallbackPlayerId;
}

module.exports = {
    nome: `${COMMAND_PREFIX}statusjogador`,
    aliases: [`${COMMAND_PREFIX}status jogador`, `${COMMAND_PREFIX}statusplayer`],
    descricao: 'Mostra o estado de cadastro de um jogador.',
    oculto: true,
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        if (!isOwner(idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: '*Esse comando e reservado para a dona do bot.*',
            });
            return;
        }

        const targetPlayerId = resolveTargetPlayerId(m, idJogador);
        const player = await getPlayerRecord(db, targetPlayerId);
        const onboarding = player ? await getOnboardingState(db, targetPlayerId) : null;
        const rollCount = player ? await getPlayerRollCount(db, targetPlayerId) : 0;
        const selectedRoll = player?.numero_roll_escolhido
            ? await getPlayerRollByNumber(db, targetPlayerId, player.numero_roll_escolhido)
            : null;
        const pendingProfile = player ? await getPendingConfirmation(db, targetPlayerId) : null;
        const pendingMagic = player ? await getPendingMagicConfirmation(db, targetPlayerId) : null;
        const pendingMagicRollNumber = pendingMagic?.roll_number || player?.numero_roll_escolhido || null;

        await sendReply({
            sock,
            idChat,
            m,
            mentions: [targetPlayerId],
            text: [
                '.',
                '     ──  𝐒𝐓𝐀𝐓𝐔𝐒 𝐃𝐎 𝐉𝐎𝐆𝐀𝐃𝐎𝐑  ──',
                '',
                `*♡  @${targetPlayerId.split('@')[0]}*`,
                '',
                `↳ *Registro* · ${player ? 'encontrado' : 'nao encontrado'}`,
                `↳ *Etapa* · ${onboarding?.current_step || '-'}`,
                `↳ *Rolls* · ${rollCount}`,
                `↳ *Roll vinculado* · ${selectedRoll ? `#${String(selectedRoll.roll_number).padStart(2, '0')} ${selectedRoll.magic_rarity}` : '-'}`,
                `↳ *Ficha* · ${player?.ficha_status || '-'}`,
                `↳ *Magia* · ${player?.magia && player.magia !== '-' ? player.magia : '-'}`,
                `↳ *Ficha pendente* · ${pendingProfile ? `#${pendingProfile.numeroRoll}` : '-'}`,
                `↳ *Magia pendente* · ${pendingMagic ? `${pendingMagic.magic_label}${pendingMagicRollNumber ? ` (#${String(pendingMagicRollNumber).padStart(2, '0')})` : ''}` : '-'}`,
            ].join('\n'),
        });
    },
};
