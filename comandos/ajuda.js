const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');

module.exports = {
    nome: `${COMMAND_PREFIX}ajuda`,
    descricao: 'Mostra os comandos principais do cadastro e do sistema.',
    executar: async ({ sock, m, idChat, comandos }) => {
        let menu = '📜 *Menu do sistema RPG*\n\n';

        comandos.forEach((cmd) => {
            if (cmd.oculto) return;
            menu += `• *${cmd.nome}* - ${cmd.descricao}\n`;
        });

        menu += `\nFluxo inicial recomendado: *${COMMAND_PREFIX}start*, *${COMMAND_PREFIX}sortear*, *${COMMAND_PREFIX}rolls*, *${COMMAND_PREFIX}Ficha*, *${COMMAND_PREFIX}confirmar* e *${COMMAND_PREFIX}continuar*.`;

        await sendReply({
            sock,
            idChat,
            m,
            text: menu,
        });
    },
};
