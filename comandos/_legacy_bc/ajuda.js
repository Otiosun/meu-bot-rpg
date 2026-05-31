const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');

module.exports = {
    nome: `${COMMAND_PREFIX}ajuda`,
    descricao: 'Mostra os comandos principais do cadastro e do sistema.',
    executar: async ({ sock, m, idChat, comandos }) => {
        let menu = '*Menu do sistema RPG*\n\n';

        menu += 'Fluxo principal agora:\n';
        menu += `- *${COMMAND_PREFIX}start*\n`;
        menu += `- *${COMMAND_PREFIX}sortear*\n`;
        menu += `- *${COMMAND_PREFIX}rolls*\n`;
        menu += `- *${COMMAND_PREFIX}ficha*\n`;
        menu += `- *${COMMAND_PREFIX}magias*\n`;
        menu += `- *${COMMAND_PREFIX}continuar*\n\n`;

        menu += 'Outros comandos disponiveis:\n';
        comandos.forEach((cmd) => {
            if (cmd.oculto) return;
            menu += `- *${cmd.nome}* - ${cmd.descricao}\n`;
        });

        menu += `\nFluxo inicial recomendado: *${COMMAND_PREFIX}start*, *${COMMAND_PREFIX}sortear*, *${COMMAND_PREFIX}rolls*, *${COMMAND_PREFIX}ficha* e *${COMMAND_PREFIX}magias*.`;

        await sendReply({
            sock,
            idChat,
            m,
            text: menu,
        });
    },
};
