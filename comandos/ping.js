const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');

function formatUptime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds || 0)));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;

    if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
}

module.exports = {
    nome: `${COMMAND_PREFIX}ping`,
    descricao: 'Confirma que o bot esta online.',
    executar: async ({ sock, m, idChat }) => {
        await sendReply({
            sock,
            idChat,
            m,
            text: [
                '𝐏𝐎𝐍𝐆',
                '     ──  clovᥱr rpg  ·  online  ──',
                '',
                `> ⤷ Status: *online*`,
                `> ⤷ Uptime: *${formatUptime(process.uptime())}*`,
            ].join('\n'),
        });
    },
};
