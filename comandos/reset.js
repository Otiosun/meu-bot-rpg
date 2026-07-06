const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner } = require('../helpers/groupAccess');
const {
    archiveAndResetPlayer,
} = require('../helpers/clover/playerReset');

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
    nome: `${COMMAND_PREFIX}reset`,
    descricao: 'Reseta um jogador do sistema.',
    oculto: true,
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        if (!isOwner(idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*Esse comando e reservado para a dona do bot.*',
                    '',
                    `Se o bot nao estiver te reconhecendo, abra o PV dele e use *${COMMAND_PREFIX}registrardona 123456* com o codigo atual de 6 digitos que esta no terminal.`,
                ].join('\n'),
            });
            return;
        }

        const targetPlayerId = resolveTargetPlayerId(m, idJogador);
        const result = await archiveAndResetPlayer({
            sock,
            db,
            playerId: targetPlayerId,
            reason: 'reset-command',
        });

        await sendReply({
            sock,
            idChat,
            m,
            mentions: [targetPlayerId],
            text: [
                `*Reset aplicado em @${targetPlayerId.split('@')[0]}.*`,
                result.backupPath ? `Backup: ${result.backupPath}` : '',
            ].filter(Boolean).join('\n'),
        });
    },
};
