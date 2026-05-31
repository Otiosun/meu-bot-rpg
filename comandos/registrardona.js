const { COMMAND_PREFIX } = require('../config/bot');
const { consumeActivationCode } = require('../helpers/activationCode');
const { registerOwnerIdentity } = require('../helpers/groupAccess');
const { sendReaction, sendReply } = require('../helpers/chatReply');

module.exports = {
    nome: `${COMMAND_PREFIX}registrardona`,
    aliases: [
        `${COMMAND_PREFIX}registrardono`,
        `${COMMAND_PREFIX}souadona`,
        `${COMMAND_PREFIX}souadono`,
    ],
    descricao: 'Registra a dona do bot pelo codigo rotativo.',
    oculto: true,
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, body }) => {
        if (idChat.endsWith('@g.us')) {
            await sendReply({
                sock,
                idChat,
                m,
                text: '*Esse comando deve ser usado no privado do bot.*',
            });
            return;
        }

        const auth = consumeActivationCode(
            body,
            `Novo codigo apos registrar a dona em ${idJogador}`
        );

        if (!auth.ok) {
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    '*Codigo invalido para registro de dona.*',
                    '',
                    `Use *${COMMAND_PREFIX}registrardona 123456* no PV com o codigo atual de 6 digitos que apareceu no terminal.`,
                ].join('\n'),
            });
            return;
        }

        registerOwnerIdentity(idJogador);

        await sendReaction({
            sock,
            idChat,
            m,
            emoji: '✅',
        });
    },
};
