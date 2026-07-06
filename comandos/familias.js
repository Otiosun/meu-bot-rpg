const { COMMAND_PREFIX } = require('../config/bot');
const { renderFamiliesText, sendSystemText } = require('../helpers/clover/systemMessages');
const { getPlayerRollByNumber } = require('../helpers/rollManager');

module.exports = {
    nome: `${COMMAND_PREFIX}familias`,
    aliases: [`${COMMAND_PREFIX}famílias`],
    descricao: 'Lista familias e vagas.',
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        const player = idJogador
            ? await db.get('SELECT numero_roll_escolhido FROM jogadores WHERE id = ?', [idJogador])
            : null;
        const selectedRoll = player?.numero_roll_escolhido
            ? await getPlayerRollByNumber(db, idJogador, player.numero_roll_escolhido)
            : null;

        await sendSystemText({
            sock,
            idChat,
            m,
            text: await renderFamiliesText(db, selectedRoll),
        });
    },
};
