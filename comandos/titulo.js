'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { TitleServiceError, activatePlayerTitle, listPlayerTitles } = require('../helpers/clover/titleService');

module.exports = {
    nome: `${COMMAND_PREFIX}titulo`,
    aliases: [`${COMMAND_PREFIX}titulos`],
    descricao: 'Lista e ativa títulos desbloqueados.',
    gameCommand: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const tokens = String(body || '').trim().split(/\s+/).filter(Boolean);
        try {
            if (tokens[0] === 'usar' && tokens[1]) {
                const result = await activatePlayerTitle(db, idJogador, tokens[1]);
                await sendReply({ sock, idChat, m, text: `Título ativo: *${result.title.title_name}*.` });
                return;
            }
            const titles = await listPlayerTitles(db, idJogador);
            await sendReply({
                sock, idChat, m,
                text: [
                    '*♧┃𝐓𝐈́𝐓𝐔𝐋𝐎𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*', '',
                    ...(titles.length
                        ? titles.map((title) => `${title.active ? '◆' : '◇'} *${title.id}* · ${title.title_name}`)
                        : ['> Você ainda não desbloqueou títulos.']),
                    '', `Ativar: *${COMMAND_PREFIX}titulo usar <id>*`,
                ].join('\n'),
            });
        } catch (error) {
            if (error instanceof TitleServiceError) {
                await sendReply({ sock, idChat, m, text: error.message });
                return;
            }
            throw error;
        }
    },
};
