const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { cancelPendingHexagonUpgrade } = require('../helpers/clover/hexagonService');

module.exports = {
    nome: `${COMMAND_PREFIX}cancelarhexagono`,
    aliases: [`${COMMAND_PREFIX}cancelarhexágono`],
    descricao: 'Cancela um up pendente do Hexágono de Mana.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        const result = await cancelPendingHexagonUpgrade(db, idJogador);

        if (!result.ok) {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '♧ 𝐒𝐄𝐌 𝐏𝐄𝐃𝐈𝐃𝐎 𝐏𝐄𝐍𝐃𝐄𝐍𝐓𝐄',
                    '',
                    `Use *̣${COMMAND_PREFIX}hexagono upar <lado>* para abrir um pedido.`,
                ].join('\n'),
            });
            return;
        }

        await sendReply({
            sock,
            idChat,
            m,
            text: [
                '♧ 𝐔𝐏 𝐂𝐀𝐍𝐂𝐄𝐋𝐀𝐃𝐎',
                '',
                `*Lado:* ${result.pending.sideLabel}`,
                `*Pedido:* ${result.pending.oldValue}/5 → ${result.pending.newValue}/5`,
                '',
                'Nenhum PH foi gasto.',
            ].join('\n'),
        });
    },
};
