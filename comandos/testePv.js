const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { enqueuePrivateText } = require('../helpers/clover/deliveryService');

module.exports = {
    nome: `${COMMAND_PREFIX}testepv`,
    aliases: [
        `${COMMAND_PREFIX}pvteste`,
        `${COMMAND_PREFIX}testeprivado`,
    ],
    descricao: 'Testa entrega privada pela fila do Mudzap.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        const text = [
            '*♧┃TESTE DE PV 𖥔 CLOVER MULTICOLOR*',
            '     ── mensagem enviada pelo Mudzap ──',
            '',
            '> Se isso chegou aqui, o Clover recebeu o comando e o Mudzap entregou o PV.',
            '> Esse é o mesmo caminho usado por anti-ghost, links e convites privados.',
        ].join('\n');

        const queued = await enqueuePrivateText(db, {
            targetJid: idJogador,
            text,
            source: 'testepv',
            reason: 'teste_manual_mudzap',
            priority: 50,
        });

        await sendReply({
            sock,
            idChat,
            m,
            text: [
                '*♧┃TESTE DE PV 𖥔 CLOVER MULTICOLOR*',
                '     ── fila do mensageiro ──',
                '',
                queued?.ok
                    ? `> Entrega criada para o Mudzap. ID: *${queued.jobId}*.`
                    : `> Não consegui criar a entrega: ${queued?.reason || 'erro desconhecido'}.`,
                '',
                `Use *${COMMAND_PREFIX}entregas* para ver o status recente.`,
            ].join('\n'),
        });
    },
};
