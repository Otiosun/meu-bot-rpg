'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getYullsSummary } = require('../helpers/clover/yullsService');

function money(value) {
    return `${Number(value || 0).toLocaleString('pt-BR')}¥`;
}

module.exports = {
    nome: `${COMMAND_PREFIX}saldo`,
    aliases: [`${COMMAND_PREFIX}carteira`],
    descricao: 'Mostra Yulls disponíveis, reservados e totais.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        const summary = await getYullsSummary(db, idJogador);
        await sendReply({
            sock, idChat, m,
            text: [
                '*♧┃𝐂𝐀𝐑𝐓𝐄𝐈𝐑𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
                '',
                `*Disponível:* ${money(summary.available)}`,
                `*Reservado:* ${money(summary.reserved)}`,
                `*Total:* ${money(summary.total)}`,
            ].join('\n'),
        });
    },
};
