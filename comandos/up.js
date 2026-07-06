const { COMMAND_PREFIX } = require('../config/bot');
const { sendSystemText } = require('../helpers/clover/systemMessages');

function siteUrl() {
    return process.env.CLOVER_SITE_PUBLIC_URL || 'https://black-clover-multicolor.lovable.app/';
}

function renderEvolutionUnavailableText() {
    return [
        '♧┃𝐒𝐈𝐒𝐓𝐄𝐌𝐀 𝐀𝐓𝐔𝐀𝐋𝐈𝐙𝐀𝐃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫',
        '     ──  evolução, UP e PH  ──',
        '',
        '_`─( ! )───── 𝗔𝘃𝗶𝘀𝗼`_',
        '',
        'ⓘ Esse comando não está disponível pelo bot agora.',
        '',
        'Veja a versão atualizada no site:',
        siteUrl(),
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}evolução`,
    aliases: [`${COMMAND_PREFIX}evolucao`],
    descricao: 'Consulta o sistema de evolucao, UP e PH.',
    gameCommand: true,
    executar: async ({ sock, m, idChat }) => {
        await sendSystemText({
            sock,
            idChat,
            m,
            text: renderEvolutionUnavailableText(),
        });
    },
};
