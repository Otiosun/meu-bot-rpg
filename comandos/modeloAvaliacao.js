const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');

const READ_MORE_BREAK = '\u031d'.repeat(1024);

function renderEvaluationTemplate() {
    return [
        '♧┃𝐀𝐕𝐀𝐋𝐈𝐀𝐃𝐎. 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫',
        READ_MORE_BREAK,
        '♧┃𝐅𝐈𝐂𝐇𝐀 𝐃𝐄 𝐀𝐕𝐀𝐋𝐈𝐀𝐂̧𝐀̃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫',
        '',
        '_`─( ✓ )───── 𝗔𝗹𝘃𝗼`_',
        '',
        '*𝐏𝐞𝐬𝐬𝐨𝐚:*',
        '',
        '_`─( ✦ )───── 𝗥𝗲𝗰𝗼𝗺𝗽𝗲𝗻𝘀𝗮𝘀`_',
        '',
        '*𝐏𝐇:*',
        '*𝐘𝐮𝐥𝐥𝐬:*',
        '*𝐄𝐬𝐭𝐫𝐞𝐥𝐚𝐬:*',
        '*𝐈𝐧𝐯𝐞𝐧𝐭𝐚́𝐫𝐢𝐨:*',
        '',
        '_`─( ◆ )───── 𝗧𝗶𝗽𝗼 𝗱𝗲 𝗧𝗿𝗲𝗶𝗻𝗼`_',
        '',
        '*𝐓𝐢𝐩𝐨 𝐝𝐞 𝐭𝐫𝐞𝐢𝐧𝐨:*',
        '( ) Treino Solo',
        '( ) Treino Duo',
        '( ) Cena Interativa',
        '( ) Cena de Vínculo',
        '( ) Cena de Consequência',
        '( ) Diário',
        '( ) Spin-Off',
        '( ) Missão de Desenvolvimento',
        '( ) Missão Auto-Narrada',
        '( ) Outro',
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}modeloavaliacao`,
    aliases: [
        `${COMMAND_PREFIX}modeloavaliação`,
        `${COMMAND_PREFIX}avaliacao`,
        `${COMMAND_PREFIX}avaliação`,
        `${COMMAND_PREFIX}fichaavaliacao`,
        `${COMMAND_PREFIX}fichaavaliação`,
    ],
    descricao: 'Mostra o modelo de ficha de avaliação rápida.',
    groupBypass: true,
    executar: async ({ sock, m, idChat }) => {
        await sendReply({
            sock,
            idChat,
            m,
            text: renderEvaluationTemplate(),
        });
    },
};
