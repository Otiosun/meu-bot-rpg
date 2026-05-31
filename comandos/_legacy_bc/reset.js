const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner } = require('../helpers/groupAccess');

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

async function resetPlayerState(db, playerId) {
    await db.exec('BEGIN TRANSACTION');

    try {
        await db.run('DELETE FROM pending_profile_confirmations WHERE player_id = ?', [playerId]);
        await db.run('DELETE FROM pending_magic_confirmations WHERE player_id = ?', [playerId]);
        await db.run('DELETE FROM player_rolls WHERE player_id = ?', [playerId]);
        await db.run('DELETE FROM player_skill_trees WHERE player_id = ?', [playerId]);
        await db.run('DELETE FROM player_progress WHERE player_id = ?', [playerId]);
        await db.run('DELETE FROM player_onboarding WHERE player_id = ?', [playerId]);
        await db.run('DELETE FROM jogadores WHERE id = ?', [playerId]);
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
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
        await resetPlayerState(db, targetPlayerId);

        await sendReply({
            sock,
            idChat,
            m,
            mentions: [targetPlayerId],
            text: `*Reset aplicado em @${targetPlayerId.split('@')[0]}.*`,
        });
    },
};
