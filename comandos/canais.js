const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');

const LORE_CHANNEL_URL = 'https://whatsapp.com/channel/0029VbCtPYyJJhzdGFfXe03x';
const NEWCOMER_CHANNEL_URL = 'https://whatsapp.com/channel/0029VbD3wv6Fy72LUXIT9c1l';

module.exports = {
    nome: `${COMMAND_PREFIX}canais`,
    aliases: [`${COMMAND_PREFIX}links`, `${COMMAND_PREFIX}guias`],
    descricao: 'Mostra os canais oficiais de lore e orientacao para novatos.',
    executar: async ({ sock, m, idChat }) => {
        await sendReply({
            sock,
            idChat,
            m,
            text: [
                '*♧┃CANAIS OFICIAIS 𖥔 CLOVER MULTICOLOR*',
                '     ──  lore e primeiros passos  ──',
                '',
                '*Canal de Lore*',
                `> ${LORE_CHANNEL_URL}`,
                '',
                '*Dicas para Novatos*',
                `> ${NEWCOMER_CHANNEL_URL}`,
            ].join('\n'),
        });
    },
};

module.exports.LORE_CHANNEL_URL = LORE_CHANNEL_URL;
module.exports.NEWCOMER_CHANNEL_URL = NEWCOMER_CHANNEL_URL;