const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getMessageContextInfo } = require('../helpers/messageContext');
const { isSameUser } = require('../helpers/groupAccess');
const { getPlayerPhase, renderGameBlockedMessage } = require('../helpers/clover/playerPhase');
const {
    formatBonusMessage,
    getCharacterBonusSummary,
} = require('../helpers/clover/characterBonusService');
const { canManagePlayer } = require('../helpers/clover/commandTargetUtils');

function getMentions(m) {
    return getMessageContextInfo(m)?.mentionedJid || [];
}

function getQuotedParticipant(m) {
    return getMessageContextInfo(m)?.participant || null;
}

function jidFromToken(token) {
    const raw = String(token || '').trim();
    if (!raw) return null;
    const withoutLeadingAt = raw.replace(/^@/, '');
    if (withoutLeadingAt.includes('@')) return withoutLeadingAt;

    const digits = withoutLeadingAt.replace(/\D/g, '');
    if (!digits) return null;
    return `${digits}@s.whatsapp.net`;
}

function splitBody(body) {
    return String(body || '').trim().split(/\s+/).filter(Boolean);
}

function resolveTarget(body, m, fallbackPlayerId) {
    const mentions = getMentions(m);
    if (mentions.length) return mentions[0];

    const quoted = getQuotedParticipant(m);
    if (quoted) return quoted;

    const first = splitBody(body)[0];
    return jidFromToken(first) || fallbackPlayerId;
}

module.exports = {
    nome: `${COMMAND_PREFIX}bonus`,
    aliases: [
        `${COMMAND_PREFIX}bônus`,
        `${COMMAND_PREFIX}beneficios`,
        `${COMMAND_PREFIX}benefícios`,
    ],
    descricao: 'Mostra bonus fixos da ficha, mana total e reserva Heart.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const targetId = resolveTarget(body, m, idJogador);
        const ownView = isSameUser(targetId, idJogador);

        if (!ownView && !await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Apenas ADM do grupo ou Owner pode ver os bonus de outro player.',
            });
            return;
        }

        if (ownView) {
            const phaseInfo = await getPlayerPhase(db, idJogador);
            if (!phaseInfo.canPlay) {
                await sendReply({ sock, idChat, m, text: renderGameBlockedMessage() });
                return;
            }
        }

        const summary = await getCharacterBonusSummary(db, targetId);
        await sendReply({
            sock,
            idChat,
            m,
            mentions: [targetId],
            text: formatBonusMessage(summary),
        });
    },
};
